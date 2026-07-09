"""Bounded canvas tick pipeline."""

from __future__ import annotations

import re
import json
import logging
from typing import Any
from pathlib import Path
from datetime import datetime, timezone, timedelta
from html.parser import HTMLParser

from dembrane.llms import MODELS, arouter_completion
from dembrane.utils import generate_uuid
from dembrane.settings import get_settings
from dembrane.redis_async import get_redis_client
from dembrane.canvas.access import CanvasReaderAccessDenied
from dembrane.canvas.events import publish_generation_nudge
from dembrane.canvas.gather import execute_gather_spec
from dembrane.canvas.ledgers import (
    state_patch,
    has_board_tab,
    fresh_canvas_state,
    render_tabbed_canvas,
    ledger_prompt_summary,
    normalize_canvas_tabs,
    apply_model_extraction,
)
from dembrane.directus_async import async_directus
from dembrane.canvas.sanitize import CanvasSanitizationError, sanitize_canvas_html

logger = logging.getLogger("dembrane.canvas.ticks")

_BANNED_VISIBLE_COPY: tuple[tuple[str, str], ...] = (
    ("real-time", "real-time"),
    ("AI", "AI"),
    ("successfully", "successfully"),
    ("\u2014", "em dash"),
)
CANVAS_TRANSCRIPT_WINDOW_CHARS = 20_000


class _VisibleTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._hidden_depth = 0
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:  # noqa: ARG002
        if tag.lower() in {"script", "style"}:
            self._hidden_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() in {"script", "style"} and self._hidden_depth > 0:
            self._hidden_depth -= 1

    def handle_data(self, data: str) -> None:
        if self._hidden_depth == 0:
            self.parts.append(data)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_dt(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = str(value).replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _as_id(value: Any) -> str | None:
    if isinstance(value, dict):
        value = value.get("id")
    return str(value) if value else None


def _choice_text(response: Any) -> str:
    try:
        content = response.choices[0].message.content
    except Exception:
        content = None
    if isinstance(content, str):
        return content
    if isinstance(response, dict):
        return ((response.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    return ""


def _skill_text() -> str:
    return (Path(__file__).with_name("skill.md")).read_text(encoding="utf-8")


def _visible_text(html: str) -> str:
    parser = _VisibleTextParser()
    parser.feed(html)
    return " ".join(part.strip() for part in parser.parts if part.strip())


def _banned_visible_copy(html: str) -> list[str]:
    text = _visible_text(html)
    lowered = text.lower()
    found: list[str] = []
    for lexeme, label in _BANNED_VISIBLE_COPY:
        if lexeme == "AI":
            if re.search(r"\bAI\b", text):
                found.append(label)
            continue
        if lexeme == "\u2014":
            if lexeme in text:
                found.append(label)
            continue
        if lexeme.lower() in lowered:
            found.append(label)
    return found


def _generation_detail(
    *,
    stripped_references: int,
    banned_copy: list[str],
    ledger_detail: dict[str, Any] | None = None,
) -> str | None:
    details: list[str] = []
    if stripped_references:
        details.append(f"stripped {stripped_references} external reference(s)")
    if banned_copy:
        details.append("banned visible copy: " + ", ".join(banned_copy))
    if ledger_detail:
        if ledger_detail.get("backfill_conversations") is not None:
            details.append(f"backfill: {ledger_detail.get('backfill_conversations')} conversations")
        outcomes = ledger_detail.get("conversation_outcomes") or []
        if outcomes:
            details.extend(str(outcome) for outcome in outcomes[:40])
        details.append(
            "ledger update: "
            f"{ledger_detail.get('quotes_added', 0)} quote(s), "
            f"{ledger_detail.get('concepts_changed', 0)} concept change(s), "
            f"crux {'changed' if ledger_detail.get('crux_changed') else 'unchanged'}, "
            f"story {'changed' if ledger_detail.get('story_changed') else 'unchanged'}, "
            f"host guide {'changed' if ledger_detail.get('host_guide_changed') else 'unchanged'}, "
            f"board {'changed' if ledger_detail.get('board_changed') else 'unchanged'}"
        )
        removed = ledger_detail.get("concepts_removed") or []
        if removed:
            details.append("concept removals: " + ", ".join(map(str, removed)))
        rejections = ledger_detail.get("rejections") or []
        if rejections:
            details.append("rejections: " + " | ".join(map(str, rejections[:12])))
    return "; ".join(details) if details else None


LIVING_CANVAS_MODEL_DISCIPLINE = """
Tabbed living canvas discipline for Flash-class models:
- Quote tracing: copied transcript sentence boundaries only; no receipt means no underline.
- Concept cloud: extract phrases from transcript only; every tile must pass a grep test.
- Size = repetition times spread; exactly 3 XL when there are at least three concepts; cap visible tiles around 20.
- Subtract words, never add; use the room's metaphors only; keep 1-2 jokes small.
- Crux is one newcomer-answerable invitation question, updated in place rather than appended.
- Host items are exact host text, rendered in their target tab, never paraphrased or dropped.
"""

MODEL_EXTRACTION_SYSTEM_PROMPT = """
You update a dembrane tabbed living canvas. Return JSON only.

Quote tracing PROCESS rules:
- While reading raw text, when a passage does real work (names a decision,
  coins a phrase, answers an open question, contradicts the wall), push a
  verbatim slice trimmed at sentence boundaries.
- Verbatim means copied, transcription quirks included. Never clean, never
  paraphrase. Copying is the anti-hallucination mechanism.
- A claim built from many quotes shows every voice; never merge quotes into
  one composite quote.

Concept cloud checklist:
1. Extract, never generate. A concept is a phrase FROM the transcript.
2. The grep test: for every tile you must be able to point at exact lines.
3. Size is repetition times spread; code will enforce tiers, you propose phrases.
4. Scarcity forces judgment: propose only concepts that earn space.
5. Subtract words, never add.
6. Use the room's metaphors only.
7. Keep 1-2 jokes, small.
8. Be gentle on hard content; leave sensitive strategy off.
9. When unsure, leave it out.

Crux rules:
- One question at a time; update it, do not append alternatives.
- A newcomer can answer it out loud: no internal references, jargon, or hidden numbers.
- Phrase as an invitation with a concrete first move.

Purpose rules:
- This wall exists for the purpose described in the brief.
- Extract ONLY material that serves it.
- Conversations unrelated to this purpose may legitimately yield zero quotes;
  returning nothing for them is correct, not a failure.
- At most one small tile of off-topic room flavor is allowed.
- Honor the brief's guardrails, including instructions not to pre-populate
  static transcript snippets into structure.

Return exactly:
{
  "quotes": [{"who": string|null, "quote": string, "conversation_id": string, "chunk_id": string|null}],
  "concepts": [{"phrase": string, "supporting_quote_indices": [0]}],
  "crux": {"question": string} | null,
  "story_slides": [{"eyebrow": string|null, "heading": string, "lede": string, "quote_indices": [0]}]
}
Quote and slide indices are zero-based into your returned quotes array.
If enabled_tabs includes a board tab, also return "board_cards":
[{"group": string, "synthesis": string, "quote_indices": [0]}].
For board cards, group by person only when the accepted receipt quotes are
attributed to that exact voice. Use "the room" for unattributed or mixed quotes.
If enabled_tabs does not include a board tab, omit board_cards.
"""

HOST_GUIDE_SYSTEM_PROMPT = """
You write the Host guide tab for a dembrane living canvas. Return JSON only.

Grounding rules:
- Use ONLY the brief, current ledgers, and recent run activity provided by the user.
- Do not invent facts, names, conflict, consensus, or absent voices.
- Keep "where_the_room_is" to 2-3 sentences.
- Give 2-3 concrete questions the host can say out loud.
- Use "under_heard" only for voices or threads with few or no receipts in the
  ledger attribution. If there is not enough evidence, return an empty array.

Return exactly:
{
  "where_the_room_is": string,
  "what_to_ask_next": [string],
  "under_heard": [string]
}
"""


async def _create_run(
    *,
    loop_id: str,
    status: str,
    started_at: datetime,
    detail: str | None = None,
    generation_id: str | None = None,
) -> dict[str, Any]:
    result = await async_directus.create_item(
        "agent_loop_run",
        {
            "id": generate_uuid(),
            "loop_id": loop_id,
            "status": status,
            "detail": detail,
            "generation_id": generation_id,
            "started_at": started_at.isoformat(),
            "finished_at": _now().isoformat(),
        },
    )
    return result["data"]


def _tick_window_key(loop_id: str, started_at: datetime, cadence_minutes: int) -> str:
    cadence_seconds = max(2, cadence_minutes) * 60
    window = int(started_at.timestamp()) // cadence_seconds
    return f"canvas:tick:{loop_id}:{window}"


async def _claim_scheduled_tick_window(loop: dict[str, Any], started_at: datetime) -> bool:
    """Return False when another scheduled tick already owns this cadence window."""
    loop_id = str(loop["id"])
    cadence = max(2, int(loop.get("cadence_minutes") or 5))
    ttl_seconds = max(30, cadence * 60 - 5)
    try:
        client = await get_redis_client()
        return bool(
            await client.set(
                _tick_window_key(loop_id, started_at, cadence),
                "1",
                ex=ttl_seconds,
                nx=True,
            )
        )
    except Exception:
        logger.warning("Redis unavailable for canvas tick idempotency", exc_info=True)
        return True


async def _update_loop_after_tick(loop: dict[str, Any], *, status: str) -> None:
    loop_id = str(loop["id"])
    if status == "ok":
        await async_directus.update_item("agent_loop", loop_id, {"failure_count": 0})
        return
    if status == "error":
        failures = int(loop.get("failure_count") or 0) + 1
        patch: dict[str, Any] = {"failure_count": failures}
        if failures >= 3:
            patch["status"] = "paused"
        await async_directus.update_item("agent_loop", loop_id, patch)


async def _enqueue_next_if_due(loop: dict[str, Any]) -> None:
    loop_id = str(loop["id"])
    fresh = await async_directus.get_item("agent_loop", loop_id)
    if not fresh or fresh.get("status") != "active":
        return
    expires_at = _parse_dt(fresh.get("expires_at"))
    now = _now()
    if expires_at and now >= expires_at:
        await async_directus.update_item("agent_loop", loop_id, {"status": "expired"})
        return
    cadence = max(2, int(fresh.get("cadence_minutes") or 5))
    next_at = now + timedelta(minutes=cadence)
    if expires_at and next_at >= expires_at:
        final_at = expires_at - timedelta(seconds=5)
        if final_at > now:
            next_at = final_at
        else:
            await async_directus.update_item("agent_loop", loop_id, {"status": "expired"})
            return
    from dembrane.scheduled_tasks import TASK_CANVAS_TICK, schedule_task

    await schedule_task(
        task_type=TASK_CANVAS_TICK,
        scheduled_at=next_at,
        payload={"loop_id": loop_id, "tick_kind": "scheduled"},
    )


async def _latest_ok_generation(report_id: str) -> dict[str, Any] | None:
    rows = await async_directus.get_items(
        "canvas_generation",
        {
            "query": {
                "filter": {"report_id": {"_eq": report_id}, "status": {"_eq": "ok"}},
                "fields": ["id", "content_html", "created_at"],
                "sort": ["-created_at"],
                "limit": 1,
            }
        },
    )
    return rows[0] if isinstance(rows, list) and rows else None


async def _latest_config(report_id: str) -> dict[str, Any]:
    from dembrane.canvas.service import get_latest_config

    config = await get_latest_config(report_id)
    if not config:
        raise RuntimeError("Canvas config revision not found")
    return config


async def _generate_html(
    *,
    brief: str,
    previous_html: str | None,
    gather_bundle: dict[str, Any],
    living_state: dict[str, Any] | None = None,
) -> str:
    if living_state is not None:
        return render_tabbed_canvas(
            state=living_state,
            project=gather_bundle.get("project") or {},
            sample_notice=gather_bundle.get("sample_notice"),
        )

    project = gather_bundle.get("project") or {}
    sample_instruction = (
        "SAMPLE MODE\nThe DATA uses sample conversations for this preview. The generated "
        "HTML must visibly say: Sample conversations, your real conversations replace these."
        if gather_bundle.get("sample_mode")
        else ""
    )
    user = "\n\n".join(
        part
        for part in [
            "PROJECT CONTEXT\n"
            f"name: {project.get('name') or 'untitled'}\n"
            f"language: {project.get('language') or 'en'}\n"
            f"context: {project.get('context') or ''}\n"
            f"anonymize_transcripts: {project.get('anonymize_transcripts')}",
            "BRIEF\n"
            "Standing instructions only. Do not treat any participant reflections, "
            "quotes, or synthesis text embedded here as data; DATA below is the "
            f"only source of gathered content.\n{brief}\n\n{LIVING_CANVAS_MODEL_DISCIPLINE}",
            "PREVIOUS DOCUMENT\n"
            + (
                previous_html
                if previous_html
                else "None yet. Create a stable layout that can be updated on later ticks."
            )
            + "\nIf a previous document exists, keep layout and section order stable.",
            sample_instruction,
            "DATA\n" + json.dumps(gather_bundle, ensure_ascii=False, indent=2),
        ]
        if part
    )
    response = await arouter_completion(
        MODELS.MULTI_MODAL_FAST,
        messages=[
            {"role": "system", "content": _skill_text()},
            {"role": "user", "content": user},
        ],
        temperature=0.2,
        max_tokens=12000,
    )
    return _choice_text(response)


def _json_from_model_text(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    parsed = json.loads(cleaned)
    if not isinstance(parsed, dict):
        raise ValueError("Canvas extraction response was not a JSON object")
    return parsed


def _gather_has_transcript(gather_bundle: dict[str, Any]) -> bool:
    for conv in gather_bundle.get("conversations") or []:
        if not isinstance(conv, dict):
            continue
        if str(conv.get("latest_transcript") or "").strip():
            return True
        for chunk in conv.get("chunks") or []:
            if isinstance(chunk, dict) and str(chunk.get("transcript") or "").strip():
                return True
    return False


def _contentful_generation(generation: dict[str, Any] | None) -> bool:
    return bool(str((generation or {}).get("content_html") or "").strip())


def _state_is_empty_wall(state: dict[str, Any]) -> bool:
    normalized = fresh_canvas_state(state)
    has_host_items = any(not item.get("removed_at") for item in normalized["host_items"])
    return (
        not normalized["quotes_ledger"]
        and not normalized["concepts_ledger"]
        and not normalized["board_cards"]
        and not has_host_items
    )


def _shape_warnings(brief: str, tabs: list[dict[str, Any]]) -> list[str]:
    normalized = brief.lower()
    warnings: list[str] = []
    asks_person_board = any(
        phrase in normalized
        for phrase in (
            "person-by-person",
            "person by person",
            "per-person",
            "per person",
            "summary person",
            "each person",
        )
    )
    if asks_person_board and not has_board_tab(tabs):
        warnings.append(
            "brief asks for person-by-person; no tab primitive supports it in the current tab set"
        )
    for phrase in ("timeline", "calendar"):
        if phrase in normalized:
            warnings.append(f"brief asks for {phrase}; no tab primitive supports it")
            break
    return warnings


def _single_conversation_bundle(
    gather_bundle: dict[str, Any],
    conversation: dict[str, Any],
) -> dict[str, Any]:
    return {
        **gather_bundle,
        "conversations": [conversation],
        "counts": {
            **(gather_bundle.get("counts") or {}),
            "conversations_with_recent_content": 1,
        },
    }


def _short_id(value: Any) -> str:
    text = str(value or "unknown")
    return text[:8] if len(text) > 8 else text


def _copy_conversation_with_chunks(
    conversation: dict[str, Any],
    chunks: list[dict[str, Any]],
) -> dict[str, Any]:
    transcript = "\n".join(str(chunk.get("transcript") or "") for chunk in chunks if chunk)
    return {
        **conversation,
        "chunks": chunks,
        "latest_transcript": transcript,
    }


def _conversation_chunks(conversation: dict[str, Any]) -> list[dict[str, Any]]:
    chunks = conversation.get("chunks") if isinstance(conversation.get("chunks"), list) else []
    if chunks:
        return [chunk for chunk in chunks if isinstance(chunk, dict)]
    return [
        {
            "id": None,
            "transcript": conversation.get("latest_transcript") or "",
            "created_at": conversation.get("created_at"),
        }
    ]


def _windowed_conversation_bundles(
    gather_bundle: dict[str, Any],
    conversation: dict[str, Any],
    *,
    window_chars: int = CANVAS_TRANSCRIPT_WINDOW_CHARS,
) -> list[dict[str, Any]]:
    window_chars = max(1000, window_chars)
    bundles: list[dict[str, Any]] = []
    current: list[dict[str, Any]] = []
    current_size = 0

    def flush() -> None:
        nonlocal current, current_size
        if not current:
            return
        bundles.append(
            _single_conversation_bundle(
                gather_bundle,
                _copy_conversation_with_chunks(conversation, current),
            )
        )
        current = []
        current_size = 0

    for chunk in _conversation_chunks(conversation):
        transcript = str(chunk.get("transcript") or "")
        if not transcript.strip():
            continue
        start = 0
        while start < len(transcript):
            remaining = window_chars - current_size
            if remaining <= 0:
                flush()
                remaining = window_chars
            piece = transcript[start : start + remaining]
            start += len(piece)
            if not piece:
                break
            current.append({**chunk, "transcript": piece})
            current_size += len(piece)
            if current_size >= window_chars:
                flush()
    flush()
    return bundles


def _transcript_payload_for_model(gather_bundle: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    remaining = max(12000, get_settings().canvas.max_total_transcript_chars)
    for conv in gather_bundle.get("conversations") or []:
        if not isinstance(conv, dict) or remaining <= 0:
            break
        chunks = conv.get("chunks") if isinstance(conv.get("chunks"), list) else []
        if not chunks:
            chunks = [
                {
                    "id": None,
                    "transcript": conv.get("latest_transcript") or "",
                    "created_at": conv.get("created_at"),
                }
            ]
        chunk_payload: list[dict[str, Any]] = []
        for chunk in chunks:
            if not isinstance(chunk, dict) or remaining <= 0:
                break
            transcript = str(chunk.get("transcript") or "").strip()
            if not transcript:
                continue
            clipped = transcript[:remaining]
            remaining -= len(clipped)
            chunk_payload.append(
                {
                    "chunk_id": chunk.get("id"),
                    "created_at": chunk.get("created_at") or chunk.get("timestamp"),
                    "transcript": clipped,
                }
            )
        if chunk_payload:
            out.append(
                {
                    "conversation_id": conv.get("id"),
                    "who": conv.get("label"),
                    "chunks": chunk_payload,
                }
            )
    return out


async def _extract_living_canvas_update(
    *,
    gather_bundle: dict[str, Any],
    current_state: dict[str, Any],
    report_name: str,
    brief: str,
) -> dict[str, Any]:
    project = gather_bundle.get("project") or {}
    user_payload = {
        "report": {"name": report_name},
        "brief": brief,
        "purpose_instruction": (
            "This wall exists for the purpose described in the brief. Extract ONLY material "
            "that serves it. Conversations unrelated to this purpose may legitimately yield "
            "zero quotes -- returning nothing for them is correct, not a failure. At most one "
            "small tile of off-topic room flavor is allowed."
        ),
        "project": {
            "name": project.get("name"),
            "language": project.get("language") or "en",
            "context": project.get("context") or "",
            "anonymize_transcripts": project.get("anonymize_transcripts"),
        },
        "enabled_tabs": normalize_canvas_tabs(current_state.get("tabs")),
        "current_ledgers": ledger_prompt_summary(current_state),
        "new_transcript": _transcript_payload_for_model(gather_bundle),
    }
    response = await arouter_completion(
        MODELS.MULTI_MODAL_FAST,
        messages=[
            {"role": "system", "content": MODEL_EXTRACTION_SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False, indent=2)},
        ],
        temperature=0.1,
        max_tokens=8000,
    )
    return _json_from_model_text(_choice_text(response))


def _ledger_attribution(state: dict[str, Any]) -> dict[str, Any]:
    normalized = fresh_canvas_state(state)
    by_conversation: dict[str, int] = {}
    by_voice: dict[str, int] = {}
    for quote in normalized["quotes_ledger"]:
        source = quote.get("source") if isinstance(quote.get("source"), dict) else {}
        conv_id = str(source.get("conversation_id") or "unknown")
        by_conversation[conv_id] = by_conversation.get(conv_id, 0) + 1
        voice = str(quote.get("who") or "participant")
        by_voice[voice] = by_voice.get(voice, 0) + 1
    return {"by_conversation": by_conversation, "by_voice": by_voice}


async def _generate_host_guide(
    *,
    report_name: str,
    brief: str,
    current_state: dict[str, Any],
    recent_activity: dict[str, Any],
) -> dict[str, Any]:
    user_payload = {
        "report": {"name": report_name},
        "brief": brief,
        "current_ledgers": ledger_prompt_summary(current_state),
        "ledger_attribution": _ledger_attribution(current_state),
        "recent_run_activity": recent_activity,
    }
    response = await arouter_completion(
        MODELS.MULTI_MODAL_FAST,
        messages=[
            {"role": "system", "content": HOST_GUIDE_SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False, indent=2)},
        ],
        temperature=0.2,
        max_tokens=1400,
    )
    parsed = _json_from_model_text(_choice_text(response))
    questions = [
        str(item).strip()[:220]
        for item in parsed.get("what_to_ask_next") or []
        if str(item).strip()
    ][:3]
    under_heard = [
        str(item).strip()[:220] for item in parsed.get("under_heard") or [] if str(item).strip()
    ][:5]
    return {
        "where_the_room_is": str(parsed.get("where_the_room_is") or "").strip()[:900],
        "what_to_ask_next": questions,
        "under_heard": under_heard,
        "updated_at": _now().isoformat(),
    }


async def _merge_extraction_for_tick(
    *,
    gather_bundle: dict[str, Any],
    current_state: dict[str, Any],
    backfill: bool,
    report_name: str,
    brief: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    living_state = fresh_canvas_state(current_state)
    combined_detail: dict[str, Any] = {
        "quotes_added": 0,
        "concepts_changed": 0,
        "crux_changed": False,
        "story_changed": False,
        "host_guide_changed": False,
        "board_changed": False,
        "concepts_removed": [],
        "rejections": [],
        "conversation_outcomes": [],
    }
    conversations = [
        conv
        for conv in gather_bundle.get("conversations") or []
        if isinstance(conv, dict) and _gather_has_transcript({"conversations": [conv]})
    ]
    if backfill:
        combined_detail["backfill_conversations"] = len(conversations)
    if not conversations:
        return living_state, combined_detail

    bundles: list[tuple[dict[str, Any], str, int | None, int]] = []
    if backfill:
        for conv in conversations:
            windows = _windowed_conversation_bundles(gather_bundle, conv)
            for window_index, bundle in enumerate(windows, start=1):
                bundles.append((bundle, str(conv.get("id") or "unknown"), window_index, len(windows)))
    else:
        oversized = any(
            sum(len(str(chunk.get("transcript") or "")) for chunk in _conversation_chunks(conv))
            > CANVAS_TRANSCRIPT_WINDOW_CHARS
            for conv in conversations
        )
        if oversized:
            for conv in conversations:
                windows = _windowed_conversation_bundles(gather_bundle, conv)
                for window_index, bundle in enumerate(windows, start=1):
                    bundles.append(
                        (bundle, str(conv.get("id") or "unknown"), window_index, len(windows))
                    )
        else:
            bundles = [(gather_bundle, "recent", None, 1)]

    for bundle, conv_id, window_index, window_count in bundles:
        try:
            extraction = await _extract_living_canvas_update(
                gather_bundle=bundle,
                current_state=living_state,
                report_name=report_name,
                brief=brief,
            )
        except Exception as exc:
            label = f"backfill conv {_short_id(conv_id)}" if backfill else f"conv {_short_id(conv_id)}"
            if window_index is not None and window_count > 1:
                label += f" window {window_index}"
            combined_detail["conversation_outcomes"].append(f"{label}: model error: {exc}")
            continue
        living_state, detail = apply_model_extraction(
            living_state,
            bundle,
            extraction,
        )
        rejected = len(detail.get("rejections") or [])
        label = f"backfill conv {_short_id(conv_id)}" if backfill else f"conv {_short_id(conv_id)}"
        if window_index is not None and window_count > 1:
            label += f" window {window_index}"
        combined_detail["conversation_outcomes"].append(
            f"{label}: {int(detail.get('quotes_added') or 0)} accepted / {rejected} rejected"
        )
        combined_detail["quotes_added"] += int(detail.get("quotes_added") or 0)
        combined_detail["concepts_changed"] += int(detail.get("concepts_changed") or 0)
        combined_detail["crux_changed"] = bool(
            combined_detail["crux_changed"] or detail.get("crux_changed")
        )
        combined_detail["story_changed"] = bool(
            combined_detail["story_changed"] or detail.get("story_changed")
        )
        combined_detail["board_changed"] = bool(
            combined_detail["board_changed"] or detail.get("board_changed")
        )
        combined_detail["concepts_removed"].extend(detail.get("concepts_removed") or [])
        combined_detail["rejections"].extend(detail.get("rejections") or [])
    try:
        host_guide = await _generate_host_guide(
            report_name=report_name,
            brief=brief,
            current_state=living_state,
            recent_activity=combined_detail,
        )
        if host_guide != living_state.get("host_guide"):
            living_state["host_guide"] = host_guide
            combined_detail["host_guide_changed"] = True
    except Exception as exc:
        combined_detail["rejections"].append(f"host guide model error: {exc}")
    return living_state, combined_detail


async def run_tick(loop_id: str, tick_kind: str = "scheduled") -> dict[str, Any]:
    """Run one bounded gather -> generate -> sanitize -> store tick."""
    started_at = _now()
    loop = await async_directus.get_item("agent_loop", loop_id)
    if not loop:
        raise RuntimeError("Canvas loop not found")

    expires_at = _parse_dt(loop.get("expires_at"))
    if expires_at and started_at >= expires_at:
        await async_directus.update_item("agent_loop", loop_id, {"status": "expired"})
        run = await _create_run(
            loop_id=loop_id,
            status="no_op",
            detail="Loop expired before tick start",
            started_at=started_at,
        )
        return {"status": "expired", "run": run}
    if loop.get("status") != "active" and tick_kind != "manual":
        run = await _create_run(
            loop_id=loop_id,
            status="no_op",
            detail=f"Loop is {loop.get('status')}",
            started_at=started_at,
        )
        return {"status": "no_op", "run": run}

    if tick_kind == "scheduled" and not await _claim_scheduled_tick_window(loop, started_at):
        run = await _create_run(
            loop_id=loop_id,
            status="no_op",
            detail="Duplicate tick for cadence window",
            started_at=started_at,
        )
        return {"status": "duplicate", "run": run}

    report_id: str | None = None
    project_id: str | None = None
    acting_user_id = ""
    try:
        report_id = _as_id(loop.get("report_id"))
        project_id = _as_id(loop.get("project_id"))
        acting_user_id = str(loop.get("acting_directus_user_id") or "")
        if not report_id or not project_id or not acting_user_id:
            raise RuntimeError("Canvas loop is missing required ids")

        config = await _latest_config(report_id)
        latest_ok = await _latest_ok_generation(report_id)
        living_state = fresh_canvas_state(loop)
        configured_tabs = normalize_canvas_tabs(config.get("tabs"))
        structure_changed = configured_tabs != normalize_canvas_tabs(living_state.get("tabs"))
        living_state["tabs"] = configured_tabs
        cold_start_backfill = not living_state["quotes_ledger"]
        gather_bundle = await execute_gather_spec(
            project_id=project_id,
            acting_directus_user_id=acting_user_id,
            gather_spec=config.get("gather_spec") or {},
            full_history=cold_start_backfill,
        )
        latest_content_at = _parse_dt(gather_bundle.get("latest_content_at"))
        latest_generation_at = _parse_dt((latest_ok or {}).get("created_at"))
        if (
            not cold_start_backfill
            and not structure_changed
            and tick_kind != "manual"
            and latest_ok
            and (
                not latest_content_at
                or (latest_generation_at and latest_content_at <= latest_generation_at)
            )
        ):
            run = await _create_run(
                loop_id=loop_id,
                status="no_op",
                detail="No new gathered content since latest generation",
                started_at=started_at,
            )
            await _enqueue_next_if_due(loop)
            return {"status": "no_op", "run": run}

        if _gather_has_transcript(gather_bundle):
            try:
                living_state, ledger_detail = await _merge_extraction_for_tick(
                    gather_bundle=gather_bundle,
                    current_state=living_state,
                    backfill=cold_start_backfill,
                    report_name=str(loop.get("name") or config.get("name") or config.get("brief") or "Canvas"),
                    brief=str(config.get("brief") or ""),
                )
            except Exception as exc:
                run = await _create_run(
                    loop_id=loop_id,
                    status="no_op",
                    detail=f"Model extraction failed: {exc}",
                    started_at=started_at,
                )
                await _enqueue_next_if_due(loop)
                return {"status": "no_op", "run": run}
        else:
            ledger_detail = {
                "quotes_added": 0,
                "concepts_changed": 0,
                "crux_changed": False,
                "story_changed": False,
                "host_guide_changed": False,
                "board_changed": False,
                "concepts_removed": [],
                "rejections": [],
                "conversation_outcomes": [],
            }
            if cold_start_backfill:
                ledger_detail["backfill_conversations"] = 0
            try:
                host_guide = await _generate_host_guide(
                    report_name=str(loop.get("name") or config.get("name") or "Canvas"),
                    brief=str(config.get("brief") or ""),
                    current_state=living_state,
                    recent_activity=ledger_detail,
                )
                if host_guide != living_state.get("host_guide"):
                    living_state["host_guide"] = host_guide
                    ledger_detail["host_guide_changed"] = True
            except Exception as exc:
                ledger_detail["rejections"].append(f"host guide model error: {exc}")
        ledger_detail["rejections"].extend(
            _shape_warnings(str(config.get("brief") or ""), living_state["tabs"])
        )

        if (
            _state_is_empty_wall(living_state)
            and _contentful_generation(latest_ok)
            and not structure_changed
        ):
            run = await _create_run(
                loop_id=loop_id,
                status="no_op",
                detail=(
                    "Empty extraction would replace a contentful previous generation; "
                    f"{_generation_detail(stripped_references=0, banned_copy=[], ledger_detail=ledger_detail)}"
                ),
                started_at=started_at,
            )
            await _enqueue_next_if_due(loop)
            return {"status": "no_op", "run": run}

        await async_directus.update_item(
            "agent_loop",
            str(loop["id"]),
            state_patch(living_state),
        )

        raw_html = await _generate_html(
            brief=str(config.get("brief") or ""),
            previous_html=(latest_ok or {}).get("content_html"),
            gather_bundle=gather_bundle,
            living_state=living_state,
        )
        sanitized = sanitize_canvas_html(raw_html, max_bytes=get_settings().canvas.max_html_bytes)
        banned_copy = _banned_visible_copy(sanitized.html)
        detail = _generation_detail(
            stripped_references=sanitized.stripped_references,
            banned_copy=banned_copy,
            ledger_detail=ledger_detail,
        )
        generation = (
            await async_directus.create_item(
                "canvas_generation",
                {
                    "id": generate_uuid(),
                    "report_id": report_id,
                    "config_revision_id": _as_id(config.get("id")),
                    "content_html": sanitized.html,
                    "status": "ok",
                    "tick_kind": tick_kind,
                    "detail": detail,
                },
            )
        )["data"]
        run = await _create_run(
            loop_id=loop_id,
            status="ok",
            generation_id=str(generation["id"]),
            detail=detail,
            started_at=started_at,
        )
        await _update_loop_after_tick(loop, status="ok")
        await publish_generation_nudge(report_id)
        await _enqueue_next_if_due(loop)
        return {"status": "ok", "generation": generation, "run": run}
    except (CanvasReaderAccessDenied, CanvasSanitizationError, Exception) as exc:
        detail = str(exc)
        generation = None
        if report_id:
            generation = (
                await async_directus.create_item(
                    "canvas_generation",
                    {
                        "id": generate_uuid(),
                        "report_id": report_id,
                        "config_revision_id": _as_id((locals().get("config") or {}).get("id")),
                        "content_html": "",
                        "status": "error",
                        "tick_kind": tick_kind,
                        "detail": detail[:5000],
                    },
                )
            )["data"]
        run = await _create_run(
            loop_id=loop_id,
            status="error",
            detail=detail[:5000],
            generation_id=str(generation["id"]) if generation else None,
            started_at=started_at,
        )
        await _update_loop_after_tick(loop, status="error")
        await _enqueue_next_if_due(loop)
        logger.warning("canvas tick failed for loop %s: %s", loop_id, detail)
        return {"status": "error", "generation": generation, "run": run}


async def reconcile_missing_canvas_tick_tasks() -> int:
    """Backfill one pending scheduled canvas tick for each active loop missing one."""
    now = _now()
    loops = await async_directus.get_items(
        "agent_loop",
        {
            "query": {
                "filter": {
                    "status": {"_eq": "active"},
                    "expires_at": {"_gt": now.isoformat()},
                },
                "fields": ["id", "expires_at"],
                "limit": -1,
            }
        },
    )
    if not isinstance(loops, list) or not loops:
        return 0

    from dembrane.scheduled_tasks import STATUS_SCHEDULED, TASK_CANVAS_TICK, STATUS_PROCESSING

    existing = await async_directus.get_items(
        "scheduled_task",
        {
            "query": {
                "filter": {
                    "task_type": {"_eq": TASK_CANVAS_TICK},
                    "status": {"_in": [STATUS_SCHEDULED, STATUS_PROCESSING]},
                },
                "fields": ["payload"],
                "limit": -1,
            }
        },
    )
    covered: set[str] = set()
    if isinstance(existing, list):
        for task in existing:
            loop_id = (task.get("payload") or {}).get("loop_id")
            if loop_id:
                covered.add(str(loop_id))

    enqueued = 0
    for loop in loops:
        loop_id = str(loop.get("id") or "")
        if not loop_id or loop_id in covered:
            continue
        await _enqueue_next_if_due(loop)
        enqueued += 1

    if enqueued:
        logger.info("Backfilled %d missing canvas tick scheduled_task row(s)", enqueued)
    return enqueued
