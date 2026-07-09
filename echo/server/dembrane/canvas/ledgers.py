"""Additive ledger state and tabbed canvas rendering."""

from __future__ import annotations

import html
from typing import Any
from datetime import datetime, timezone
from urllib.parse import quote as url_quote

from dembrane.utils import generate_uuid

CANVAS_TAB_SET_V1 = ("crux", "concept_cloud", "story", "host_guide")
CANVAS_SUPPORTED_TAB_KINDS = ("crux", "concept_cloud", "story", "host_guide", "board")
CANVAS_TAB_LABELS = {
    "crux": "Crux",
    "concept_cloud": "Concept cloud",
    "story": "Story",
    # Internal state remains canvas_host_guide for migration stability; only
    # the host-visible tab label is renamed.
    "host_guide": "Open questions",
    "board": "Board",
}
HOST_TARGET_TABS = {"crux", "concept_cloud", "story"}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def fresh_canvas_state(loop: dict[str, Any] | None = None) -> dict[str, Any]:
    loop = loop or {}
    return {
        "schema_version": 1,
        "tabs": normalize_canvas_tabs(loop.get("tabs") or loop.get("canvas_tabs")),
        "quotes_ledger": _list(loop.get("quotes_ledger") or loop.get("canvas_quotes_ledger")),
        "concepts_ledger": _list(loop.get("concepts_ledger") or loop.get("canvas_concepts_ledger")),
        "crux": _dict(loop.get("crux") or loop.get("canvas_crux"))
        or {"question": "", "history": []},
        "host_items": _list(loop.get("host_items") or loop.get("canvas_host_items")),
        "story_slides": _list(loop.get("story_slides") or loop.get("canvas_story_slides")),
        "host_guide": _dict(loop.get("host_guide") or loop.get("canvas_host_guide")),
        "board_cards": _list(loop.get("board_cards") or loop.get("canvas_board_cards")),
    }


def state_patch(state: dict[str, Any]) -> dict[str, Any]:
    return {
        "canvas_tabs": normalize_canvas_tabs(state.get("tabs")),
        "canvas_quotes_ledger": state.get("quotes_ledger") or [],
        "canvas_concepts_ledger": state.get("concepts_ledger") or [],
        "canvas_crux": state.get("crux") or {"question": "", "history": []},
        "canvas_host_items": state.get("host_items") or [],
        "canvas_story_slides": state.get("story_slides") or [],
        "canvas_host_guide": state.get("host_guide") or {},
        "canvas_board_cards": state.get("board_cards") or [],
    }


def normalize_canvas_tabs(tabs: Any) -> list[dict[str, Any]]:
    source = tabs if isinstance(tabs, list) and tabs else list(CANVAS_TAB_SET_V1)
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in source:
        tab = _normalize_tab_config(raw)
        if not tab:
            continue
        key = _tab_key(tab)
        if key in seen:
            continue
        seen.add(key)
        normalized.append(tab)
    if not normalized:
        return [{"kind": kind} for kind in CANVAS_TAB_SET_V1]
    return normalized


def _normalize_tab_config(raw: Any) -> dict[str, Any] | None:
    if isinstance(raw, str):
        kind = _normalize_tab_kind(raw)
        return {"kind": kind} if kind else None
    if not isinstance(raw, dict):
        return None
    kind = _normalize_tab_kind(raw.get("kind") or raw.get("tab") or raw.get("type"))
    if not kind:
        return None
    tab: dict[str, Any] = {"kind": kind}
    if kind == "board":
        grouping = str(raw.get("grouping") or "person").strip().lower()
        tab["grouping"] = "person" if grouping in {"", "voice", "speaker"} else grouping
    return tab


def _normalize_tab_kind(value: Any) -> str | None:
    normalized = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    aliases = {
        "cloud": "concept_cloud",
        "concept": "concept_cloud",
        "concepts": "concept_cloud",
        "concepts_cloud": "concept_cloud",
        "host": "host_guide",
        "guide": "host_guide",
        "person_board": "board",
        "people": "board",
        "per_person": "board",
    }
    normalized = aliases.get(normalized, normalized)
    return normalized if normalized in CANVAS_SUPPORTED_TAB_KINDS else None


def _tab_kind(tab: Any) -> str:
    if isinstance(tab, dict):
        return str(tab.get("kind") or "")
    return str(tab or "")


def _tab_key(tab: dict[str, Any]) -> str:
    if tab.get("kind") == "board":
        return f"board:{tab.get('grouping') or 'person'}"
    return str(tab.get("kind") or "")


def has_board_tab(state_or_tabs: Any) -> bool:
    tabs = state_or_tabs.get("tabs") if isinstance(state_or_tabs, dict) else state_or_tabs
    return any(_tab_kind(tab) == "board" for tab in normalize_canvas_tabs(tabs))


def host_item(
    *,
    text: str,
    target_tab: str,
    person: str | None,
    chat_id: str | None,
    message_id: str | None,
) -> dict[str, Any]:
    normalized_target = normalize_target_tab(target_tab)
    return {
        "id": generate_uuid(),
        "text": text.strip(),
        "person": person.strip() if person else None,
        "target_tab": normalized_target,
        "source": {"chat_id": chat_id, "message_id": message_id},
        "added_at": utc_now_iso(),
        "removed_at": None,
    }


def normalize_target_tab(target_tab: str | None) -> str:
    normalized = (target_tab or "story").strip().lower().replace("-", "_").replace(" ", "_")
    aliases = {"cloud": "concept_cloud", "concept": "concept_cloud", "concepts": "concept_cloud"}
    normalized = aliases.get(normalized, normalized)
    if normalized not in HOST_TARGET_TABS:
        raise ValueError("target_tab must be one of crux, concept_cloud, or story")
    return normalized


def append_host_item(state: dict[str, Any], item: dict[str, Any]) -> dict[str, Any]:
    state = fresh_canvas_state(state)
    state["host_items"] = [*state["host_items"], item]
    return state


def remove_host_item(state: dict[str, Any], item_id_or_text: str) -> tuple[dict[str, Any], bool]:
    state = fresh_canvas_state(state)
    needle = item_id_or_text.strip().lower()
    removed = False
    items: list[dict[str, Any]] = []
    for item in state["host_items"]:
        if item.get("removed_at"):
            items.append(item)
            continue
        matches_id = str(item.get("id") or "").lower() == needle
        matches_text = needle and needle in str(item.get("text") or "").lower()
        if matches_id or matches_text:
            item = {**item, "removed_at": utc_now_iso()}
            removed = True
        items.append(item)
    state["host_items"] = items
    return state, removed


def apply_model_extraction(
    state: dict[str, Any],
    gather_bundle: dict[str, Any],
    extraction: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    state = fresh_canvas_state(state)
    now = utc_now_iso()
    transcript_index = _transcript_index(gather_bundle)
    accepted_quotes, quote_index_to_id, quote_rejections = _accept_model_quotes(
        state,
        extraction,
        transcript_index,
        now,
    )
    concept_changes, concept_rejections = _merge_model_concepts(
        state,
        extraction,
        quote_index_to_id,
        now,
    )
    crux_changed, crux_rejections = _update_model_crux(state, extraction, now)
    story_changed, story_rejections = _merge_story_slides(state, extraction, quote_index_to_id, now)
    board_changed, board_rejections = _merge_board_cards(state, extraction, quote_index_to_id, now)
    return state, {
        "quotes_added": accepted_quotes,
        "concepts_changed": concept_changes,
        "crux_changed": crux_changed,
        "story_changed": story_changed,
        "board_changed": board_changed,
        "concepts_removed": [],
        "rejections": quote_rejections
        + concept_rejections
        + crux_rejections
        + story_rejections
        + board_rejections,
    }


def ledger_prompt_summary(state: dict[str, Any]) -> dict[str, Any]:
    state = fresh_canvas_state(state)
    ranked_concepts = sorted(
        state["concepts_ledger"],
        key=lambda c: (_concept_score(c, state["quotes_ledger"]), c.get("last_reinforced") or ""),
        reverse=True,
    )[:24]
    return {
        "concepts": [
            {"phrase": c.get("phrase"), "size_tier": c.get("size_tier")}
            for c in ranked_concepts
            if c.get("phrase")
        ],
        "crux": (state.get("crux") or {}).get("question") or None,
        "story_headings": [
            slide.get("heading")
            for slide in state.get("story_slides") or []
            if isinstance(slide, dict) and slide.get("heading")
        ][:8],
        "board_groups": [
            card.get("group")
            for card in state.get("board_cards") or []
            if isinstance(card, dict) and card.get("group")
        ][:12],
    }


def _transcript_index(gather_bundle: dict[str, Any]) -> dict[str, dict[str, Any]]:
    index: dict[str, dict[str, Any]] = {}
    for conv in _list(gather_bundle.get("conversations")):
        conv_id = str(conv.get("id") or "")
        if not conv_id:
            continue
        chunks = _list(conv.get("chunks"))
        if not chunks:
            chunks = [
                {
                    "id": None,
                    "transcript": conv.get("latest_transcript") or "",
                    "created_at": conv.get("created_at"),
                }
            ]
        transcript_parts = [str(chunk.get("transcript") or "") for chunk in chunks]
        index[conv_id] = {
            "label": conv.get("label") if conv.get("label") != "participant" else None,
            "created_at": conv.get("created_at"),
            "text": "\n".join(part for part in transcript_parts if part),
            "chunks": {
                str(chunk.get("id") or ""): {
                    "text": str(chunk.get("transcript") or ""),
                    "created_at": chunk.get("created_at") or chunk.get("timestamp"),
                }
                for chunk in chunks
            },
        }
    return index


def _accept_model_quotes(
    state: dict[str, Any],
    extraction: dict[str, Any],
    transcript_index: dict[str, dict[str, Any]],
    now: str,
) -> tuple[int, dict[int, str], list[str]]:
    seen = {
        (
            str(q.get("source", {}).get("conversation_id") or ""),
            str(q.get("source", {}).get("chunk_id") or ""),
            str(q.get("quote") or "").strip(),
        )
        for q in state["quotes_ledger"]
    }
    appended = 0
    quote_index_to_id: dict[int, str] = {}
    rejections: list[str] = []
    for model_index, quote in enumerate(_list(extraction.get("quotes"))):
        text = str(quote.get("quote") or "").strip()
        conv_id = str(quote.get("conversation_id") or "")
        raw_chunk_id = quote.get("chunk_id")
        chunk_id = str(raw_chunk_id) if raw_chunk_id else ""
        conv = transcript_index.get(conv_id)
        if not text or not conv:
            rejections.append(f"quote[{model_index}] missing text or conversation: {text[:80]}")
            continue
        if _normalize_ws(text) not in _normalize_ws(str(conv.get("text") or "")):
            rejections.append(f"quote[{model_index}] not found verbatim: {text[:120]}")
            continue
        key = (conv_id, chunk_id, text)
        existing_id = _existing_quote_id(state, conv_id, chunk_id, text)
        if existing_id:
            quote_index_to_id[model_index] = existing_id
            continue
        if key in seen:
            continue
        seen.add(key)
        chunk = (conv.get("chunks") or {}).get(chunk_id) or {}
        quote_id = generate_uuid()
        quote_index_to_id[model_index] = quote_id
        state["quotes_ledger"].append(
            {
                "id": quote_id,
                "who": quote.get("who") or conv.get("label"),
                "quote": text,
                "source": {"conversation_id": conv_id, "chunk_id": chunk_id or None},
                "when": chunk.get("created_at") or conv.get("created_at") or now,
            }
        )
        appended += 1
    return appended, quote_index_to_id, rejections


def _merge_model_concepts(
    state: dict[str, Any],
    extraction: dict[str, Any],
    quote_index_to_id: dict[int, str],
    now: str,
) -> tuple[int, list[str]]:
    by_phrase = {
        str(concept.get("phrase") or "").lower(): concept
        for concept in state["concepts_ledger"]
        if concept.get("phrase")
    }
    changed = 0
    rejections: list[str] = []
    quotes_by_id = {str(quote.get("id")): quote for quote in state["quotes_ledger"]}
    for model_index, concept_input in enumerate(_list(extraction.get("concepts"))):
        phrase = str(concept_input.get("phrase") or "").strip()
        if not phrase:
            rejections.append(f"concept[{model_index}] empty phrase")
            continue
        quote_ids = _supported_quote_ids(
            concept_input.get("supporting_quote_indices"), quote_index_to_id
        )
        if not quote_ids:
            rejections.append(
                f"concept[{model_index}] has no accepted supporting quote: {phrase[:80]}"
            )
            continue
        if not any(
            _normalize_ws(phrase) in _normalize_ws(str(quotes_by_id[qid].get("quote") or ""))
            for qid in quote_ids
            if qid in quotes_by_id
        ):
            rejections.append(
                f"concept[{model_index}] phrase not found in supporting quote: {phrase[:80]}"
            )
            continue
        key = phrase.lower()
        concept = by_phrase.get(key)
        if not concept:
            concept = {
                "id": generate_uuid(),
                "phrase": phrase,
                "quote_ids": [],
                "size_tier": "s",
                "first_seen": now,
                "last_reinforced": now,
            }
            state["concepts_ledger"].append(concept)
            by_phrase[key] = concept
            changed += 1
        for quote_id in quote_ids:
            if quote_id in concept["quote_ids"]:
                continue
            concept["quote_ids"].append(quote_id)
            concept["last_reinforced"] = now
            changed += 1

    ranked = sorted(
        state["concepts_ledger"],
        key=lambda c: (_concept_score(c, state["quotes_ledger"]), c.get("first_seen") or ""),
        reverse=True,
    )
    for index, concept in enumerate(ranked):
        old = concept.get("size_tier")
        if index < 3 and len(ranked) >= 3:
            tier = "xl"
        elif index < 7:
            tier = "l"
        elif index < 13:
            tier = "m"
        else:
            tier = "s"
        if old != tier:
            concept["size_tier"] = tier
            changed += 1
    return changed, rejections


def _update_model_crux(
    state: dict[str, Any], extraction: dict[str, Any], now: str
) -> tuple[bool, list[str]]:
    crux_input = extraction.get("crux")
    if crux_input is None:
        return False, []
    if not isinstance(crux_input, dict):
        return False, ["crux was not an object or null"]
    question = str(crux_input.get("question") or "").strip()
    if not question:
        return False, ["crux question was empty"]
    if len(question) > 180:
        return False, ["crux question was over 180 characters"]
    current = str((state.get("crux") or {}).get("question") or "").strip()
    if question == current:
        return False, []
    crux = state.setdefault("crux", {"question": "", "history": []})
    if current:
        crux.setdefault("history", []).append({"question": current, "replaced_at": now})
    crux["question"] = question
    crux["updated_at"] = now
    return True, []


def _merge_story_slides(
    state: dict[str, Any],
    extraction: dict[str, Any],
    quote_index_to_id: dict[int, str],
    now: str,
) -> tuple[bool, list[str]]:
    slides = _list(extraction.get("story_slides"))
    if not slides:
        return False, []
    accepted: list[dict[str, Any]] = []
    rejections: list[str] = []
    for index, slide in enumerate(slides[:8]):
        heading = str(slide.get("heading") or "").strip()
        if not heading:
            rejections.append(f"story_slides[{index}] empty heading")
            continue
        accepted.append(
            {
                "id": str(slide.get("id") or generate_uuid()),
                "eyebrow": str(slide.get("eyebrow") or "").strip() or None,
                "heading": heading[:180],
                "lede": str(slide.get("lede") or "").strip()[:600],
                "quote_ids": _supported_quote_ids(slide.get("quote_indices"), quote_index_to_id),
                "updated_at": now,
            }
        )
    if not accepted:
        return False, rejections
    state["story_slides"] = accepted
    return True, rejections


def _merge_board_cards(
    state: dict[str, Any],
    extraction: dict[str, Any],
    quote_index_to_id: dict[int, str],
    now: str,
) -> tuple[bool, list[str]]:
    if not has_board_tab(state):
        return False, []
    cards = _list(extraction.get("board_cards"))
    if not cards:
        return False, []

    quotes_by_id = {str(quote.get("id")): quote for quote in state["quotes_ledger"]}
    existing_by_group = {
        str(card.get("group") or "").strip().lower(): card
        for card in state["board_cards"]
        if card.get("group")
    }
    changed = False
    rejections: list[str] = []
    for index, card_input in enumerate(cards[:24]):
        quote_ids = _supported_quote_ids(card_input.get("quote_indices"), quote_index_to_id)
        evidence = [quotes_by_id[qid] for qid in quote_ids if qid in quotes_by_id]
        if not evidence:
            rejections.append(f"board_cards[{index}] has no accepted receipt quote")
            continue
        group = _board_group_for_quotes(evidence)
        synthesis = str(card_input.get("synthesis") or "").strip()
        if not synthesis:
            rejections.append(f"board_cards[{index}] empty synthesis for {group}")
            continue
        key = group.lower()
        card = existing_by_group.get(key)
        if not card:
            card = {
                "id": generate_uuid(),
                "group": group,
                "grouping": "person",
                "synthesis": "",
                "quote_ids": [],
                "first_seen": now,
                "updated_at": now,
            }
            state["board_cards"].append(card)
            existing_by_group[key] = card
            changed = True
        if card.get("synthesis") != synthesis[:700]:
            card["synthesis"] = synthesis[:700]
            card["updated_at"] = now
            changed = True
        current_quote_ids = [str(qid) for qid in card.get("quote_ids") or []]
        for quote_id in quote_ids:
            if quote_id not in current_quote_ids:
                current_quote_ids.append(quote_id)
                changed = True
        card["quote_ids"] = current_quote_ids[-8:]
    return changed, rejections


def _board_group_for_quotes(quotes: list[dict[str, Any]]) -> str:
    voices = {
        str(quote.get("who") or "").strip()
        for quote in quotes
        if str(quote.get("who") or "").strip()
        and str(quote.get("who") or "").strip().lower() != "participant"
    }
    if len(voices) == 1:
        return next(iter(voices))
    return "the room"


def render_tabbed_canvas(
    *,
    state: dict[str, Any],
    project: dict[str, Any],
    sample_notice: str | None = None,
    report_name: str | None = None,
) -> str:
    state = fresh_canvas_state(state)
    tabs = normalize_canvas_tabs(state["tabs"])
    if not tabs:
        tabs = normalize_canvas_tabs(CANVAS_TAB_SET_V1)
    project_name = html.escape(str(project.get("name") or "Canvas"))
    sample = (
        f'<p class="tabbed-canvas-notice">{html.escape(sample_notice)}</p>' if sample_notice else ""
    )
    controls = "\n".join(
        f'<input class="tabbed-canvas-radio" type="radio" name="canvas-tab" id="canvas-tab-{_tab_dom_id(tab)}" {"checked" if index == 0 else ""}>'
        for index, tab in enumerate(tabs)
    )
    labels = "\n".join(
        f'<label class="tabbed-canvas-tab" for="canvas-tab-{_tab_dom_id(tab)}">{html.escape(CANVAS_TAB_LABELS[_tab_kind(tab)])}</label>'
        for tab in tabs
    )
    panels = "\n".join(_panel(tab, state) for tab in tabs)
    new_tab_href = _new_tab_chat_href(project, report_name=report_name)
    return f"""
<div class="canvas-shell tabbed-canvas" data-canvas-schema="tabbed-v1">
  <style>{_CSS}</style>
  <div class="tabbed-canvas-frame">
    <p class="tabbed-canvas-kicker">{project_name}</p>
    {sample}
    {controls}
    <nav class="tabbed-canvas-tabbar" aria-label="Canvas tabs">
      {labels}
      <a class="tabbed-canvas-add" href="{new_tab_href}" target="_top" aria-label="Open a chat to request a new tab">+</a>
    </nav>
    {panels}
  </div>
</div>
""".strip()


def _panel(tab: Any, state: dict[str, Any]) -> str:
    tab_config = _normalize_tab_config(tab)
    if not tab_config:
        tab_config = {"kind": str(tab)}
    kind = _tab_kind(tab_config)
    label = html.escape(CANVAS_TAB_LABELS[kind])
    if kind == "crux":
        body = _render_crux(state)
    elif kind == "concept_cloud":
        body = _render_cloud(state)
    elif kind == "host_guide":
        body = _render_host_guide(state)
    elif kind == "board":
        body = _render_board(state)
    else:
        body = _render_story(state)
    dom_id = _tab_dom_id(tab_config)
    return f'<section class="tabbed-canvas-panel tabbed-canvas-panel-{dom_id}" data-tab-panel="{dom_id}" aria-label="{label}">{body}</section>'


def _render_crux(state: dict[str, Any]) -> str:
    question = html.escape(
        str((state.get("crux") or {}).get("question") or "What should we listen for next?")
    )
    host = _render_host_items(state, "crux")
    return f"""
<div class="tabbed-crux">
  <p class="tabbed-canvas-kicker">Crux</p>
  <h1>{question}</h1>
  <p class="tabbed-canvas-lede">Scan the room and give your first answer out loud: one move, one bet, one reason it works.</p>
  {host}
</div>
""".strip()


def _render_cloud(state: dict[str, Any]) -> str:
    concepts = sorted(
        state["concepts_ledger"],
        key=lambda c: (
            {"xl": 4, "l": 3, "m": 2, "s": 1}.get(str(c.get("size_tier")), 1),
            c.get("last_reinforced") or "",
        ),
        reverse=True,
    )[:20]
    if not concepts:
        tiles = (
            '<p class="tabbed-canvas-empty">Concepts will appear as transcript receipts arrive.</p>'
        )
    else:
        tiles = "\n".join(
            _concept_tile(concept, state["quotes_ledger"], index)
            for index, concept in enumerate(concepts)
        )
    return f'<div class="tabbed-cloud">{tiles}{_render_host_items(state, "concept_cloud")}</div>'


def _render_story(state: dict[str, Any]) -> str:
    slides = state.get("story_slides") or []
    if slides:
        slide_html = "\n".join(_story_slide(slide, state["quotes_ledger"]) for slide in slides)
    else:
        quotes = state["quotes_ledger"][-4:]
        if quotes:
            slide_html = "\n".join(_quote_block(q) for q in quotes)
        else:
            slide_html = '<p class="tabbed-canvas-empty">The story is waiting for the first usable room quotes.</p>'
        heading = html.escape(str((state.get("crux") or {}).get("question") or "What is emerging?"))
        slide_html = f"""
<article class="tabbed-story-slide">
  <p class="tabbed-canvas-kicker">Story</p>
  <h3>{heading}</h3>
  <div class="tabbed-story-evidence">{slide_html}</div>
</article>
""".strip()
    return f"""
<div class="tabbed-story">
  <div class="tabbed-story-stack">{slide_html}</div>
  {_render_host_items(state, "story")}
</div>
""".strip()


def _render_host_guide(state: dict[str, Any]) -> str:
    guide = state.get("host_guide") if isinstance(state.get("host_guide"), dict) else {}
    where = str(guide.get("where_the_room_is") or "").strip()
    questions = [
        str(item).strip() for item in guide.get("what_to_ask_next") or [] if str(item).strip()
    ][:3]
    under_heard = [
        str(item).strip() for item in guide.get("under_heard") or [] if str(item).strip()
    ][:5]
    if not where and not questions and not under_heard:
        body = '<p class="tabbed-canvas-empty">Open questions are waiting for usable room receipts.</p>'
    else:
        where_html = (
            f'<p class="tabbed-open-orient">{html.escape(where)}</p>'
            if where
            else ""
        )
        questions_html = ""
        if questions:
            rows = "".join(f"<li>{html.escape(question)}</li>" for question in questions)
            questions_html = (
                f'<section class="tabbed-guide-block"><h3>What to ask next</h3><ol>{rows}</ol></section>'
            )
        under_heard_html = ""
        if under_heard:
            rows = "".join(f"<li>{html.escape(item)}</li>" for item in under_heard)
            under_heard_html = (
                f'<section class="tabbed-guide-block"><h3>Under-heard</h3><ul>{rows}</ul></section>'
            )
        body = where_html + questions_html + under_heard_html
    return f"""
<div class="tabbed-host-guide">
  <p class="tabbed-canvas-kicker">Open questions</p>
  {body}
</div>
""".strip()


def _render_board(state: dict[str, Any]) -> str:
    cards = state.get("board_cards") or []
    if not cards:
        body = '<p class="tabbed-canvas-empty">The board is waiting for attributed receipt quotes.</p>'
    else:
        body = "\n".join(_board_card(card, state["quotes_ledger"]) for card in cards[:30])
    return f"""
<div class="tabbed-board">
  {body}
</div>
""".strip()


def _story_slide(slide: dict[str, Any], quotes: list[dict[str, Any]]) -> str:
    eyebrow = str(slide.get("eyebrow") or "").strip()
    eyebrow_html = f'<p class="tabbed-canvas-kicker">{html.escape(eyebrow)}</p>' if eyebrow else ""
    quote_ids = {str(qid) for qid in slide.get("quote_ids") or []}
    evidence = [quote for quote in quotes if str(quote.get("id")) in quote_ids]
    trace = "\n".join(_quote_block(q) for q in evidence[:3])
    lede = html.escape(str(slide.get("lede") or ""))
    if lede and evidence:
        lede_html = f'<details class="tabbed-slide-trace"><summary><span class="tabbed-traceable">{lede}</span></summary><div class="tabbed-trace">{trace}</div></details>'
    elif lede:
        lede_html = f'<p class="tabbed-canvas-lede">{lede}</p>'
    else:
        lede_html = trace
    return f"""
<article class="tabbed-story-slide">
  {eyebrow_html}
  <h3>{html.escape(str(slide.get("heading") or ""))}</h3>
  {lede_html}
</article>
""".strip()


def _legacy_story_quotes(state: dict[str, Any]) -> str:
    quotes = state["quotes_ledger"][-4:]
    if not quotes:
        quote_html = '<p class="tabbed-canvas-empty">The story is waiting for the first usable room quotes.</p>'
    else:
        quote_html = "\n".join(_quote_block(q) for q in quotes)
    return quote_html


def _concept_tile(concept: dict[str, Any], quotes: list[dict[str, Any]], index: int) -> str:
    phrase = html.escape(str(concept.get("phrase") or ""))
    tier = html.escape(str(concept.get("size_tier") or "s"))
    quote_ids = [str(qid) for qid in concept.get("quote_ids") or []]
    evidence = [q for q in quotes if str(q.get("id")) in quote_ids]
    trace = "\n".join(_quote_block(q) for q in evidence[:4])
    rotation = "pos" if index % 2 else "neg"
    if trace:
        return f"""
<details class="tabbed-concept tabbed-concept-{tier} tabbed-tilt-{rotation}">
  <summary><span class="tabbed-traceable">{phrase}</span></summary>
  <div class="tabbed-trace">{trace}</div>
</details>
""".strip()
    return f'<div class="tabbed-concept tabbed-concept-{tier} tabbed-tilt-{rotation}"><span>{phrase}</span></div>'


def _board_card(card: dict[str, Any], quotes: list[dict[str, Any]]) -> str:
    group = html.escape(str(card.get("group") or "the room"))
    synthesis = html.escape(str(card.get("synthesis") or ""))
    quote_ids = {str(qid) for qid in card.get("quote_ids") or []}
    evidence = [quote for quote in quotes if str(quote.get("id")) in quote_ids]
    trace = "\n".join(_quote_block(q) for q in evidence[:2])
    receipt_html = ""
    if trace:
        receipt_html = (
            '<details class="tabbed-board-trace">'
            '<summary><span class="tabbed-traceable">Receipts</span></summary>'
            f'<div class="tabbed-trace">{trace}</div></details>'
        )
    return f"""
<article class="tabbed-board-card">
  <h3>{group}</h3>
  <p>{synthesis}</p>
  {receipt_html}
</article>
""".strip()


def _quote_block(quote: dict[str, Any]) -> str:
    text = html.escape(str(quote.get("quote") or ""))
    who = html.escape(str(quote.get("who") or "participant"))
    when = html.escape(str(quote.get("when") or ""))
    return f'<blockquote class="tabbed-quote"><p>“{text}”</p><footer>{who} · {when}</footer></blockquote>'


def _render_host_items(state: dict[str, Any], tab: str) -> str:
    items = [
        item
        for item in state["host_items"]
        if not item.get("removed_at") and item.get("target_tab") == tab
    ]
    if not items:
        return ""
    rows = "\n".join(
        f'<div class="tabbed-host-item"><p>{html.escape(str(item.get("text") or ""))}</p><footer>{html.escape(str(item.get("person") or "host"))}</footer></div>'
        for item in items
    )
    return f'<div class="tabbed-host-items">{rows}</div>'


def _tab_dom_id(tab: Any) -> str:
    kind = _tab_kind(tab)
    if kind == "board" and isinstance(tab, dict):
        return f"board_{str(tab.get('grouping') or 'person')}"
    return kind


def _language_segment(language: Any) -> str:
    mapping = {
        "cs": "cs-CZ",
        "cs-CZ": "cs-CZ",
        "de": "de-DE",
        "de-DE": "de-DE",
        "en": "en-US",
        "en-US": "en-US",
        "es": "es-ES",
        "es-ES": "es-ES",
        "fr": "fr-FR",
        "fr-FR": "fr-FR",
        "it": "it-IT",
        "it-IT": "it-IT",
        "nl": "nl-NL",
        "nl-NL": "nl-NL",
        "uk": "uk-UA",
        "uk-UA": "uk-UA",
    }
    return mapping.get(str(language or "").strip(), "en-US")


def _new_tab_chat_href(project: dict[str, Any], *, report_name: str | None = None) -> str:
    workspace_id = str(project.get("workspace_id") or "").strip()
    project_id = str(project.get("id") or "").strip()
    if not workspace_id or not project_id:
        return "#"
    canvas_name = str(report_name or project.get("report_name") or project.get("name") or "this").strip()
    prefill = url_quote(f"I need a new tab in the {canvas_name} canvas: ", safe="")
    lang = url_quote(_language_segment(project.get("language")), safe="")
    workspace = url_quote(workspace_id, safe="")
    project_path_id = url_quote(project_id, safe="")
    return f"/{lang}/w/{workspace}/projects/{project_path_id}/chats/new?prefill={prefill}"


def _normalize_ws(value: str) -> str:
    return " ".join(value.split())


def _existing_quote_id(
    state: dict[str, Any],
    conversation_id: str,
    chunk_id: str,
    quote_text: str,
) -> str | None:
    normalized_quote = _normalize_ws(quote_text)
    for quote in state["quotes_ledger"]:
        source = quote.get("source") or {}
        if str(source.get("conversation_id") or "") != conversation_id:
            continue
        if str(source.get("chunk_id") or "") != chunk_id:
            continue
        if _normalize_ws(str(quote.get("quote") or "")) == normalized_quote:
            return str(quote.get("id") or "")
    return None


def _supported_quote_ids(
    raw_indices: Any,
    quote_index_to_id: dict[int, str],
) -> list[str]:
    out: list[str] = []
    for raw_index in raw_indices if isinstance(raw_indices, list) else []:
        try:
            index = int(raw_index)
        except (TypeError, ValueError):
            continue
        quote_id = quote_index_to_id.get(index)
        if quote_id and quote_id not in out:
            out.append(quote_id)
    return out


def _concept_score(concept: dict[str, Any], quotes: list[dict[str, Any]]) -> int:
    quote_ids = {str(qid) for qid in concept.get("quote_ids") or []}
    spread = {
        str(q.get("source", {}).get("conversation_id") or "")
        for q in quotes
        if str(q.get("id")) in quote_ids
    }
    return len(quote_ids) + len(spread) * 2


def _list(value: Any) -> list[dict[str, Any]]:
    return value if isinstance(value, list) else []


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


_CSS = """
:root{--parchment:#F6F4F1;--card:#FFFFFF;--ink:#2D2D2C;--ink-soft:#6E6B66;--royal:#4169E1;--hairline:#E6E3DF;--amber:#FFD166}
.tabbed-canvas{font-family:"DM Sans",system-ui,sans-serif;color:var(--ink);background:var(--parchment)}
.tabbed-canvas-frame{padding:14px 26px 80px}
.tabbed-canvas-kicker{margin:0 0 10px;font-size:11px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--royal)}
.tabbed-canvas-notice{border:1px solid var(--amber);background:rgba(255,209,102,.35);padding:12px 13px;margin:0 0 14px}
.tabbed-canvas-radio{position:absolute;opacity:0;pointer-events:none}
.tabbed-canvas-tabbar{display:flex;align-items:end;border-bottom:1px solid var(--hairline);gap:26px;margin:0 0 26px}
.tabbed-canvas-tab{font-size:14.5px;font-weight:500;color:var(--ink-soft);border-bottom:2px solid transparent;padding:10px 2px;cursor:pointer}
.tabbed-canvas-add{margin-left:auto;color:var(--royal);font-size:22px;line-height:1.6;text-decoration:none}
.tabbed-canvas-panel{display:none}
#canvas-tab-crux:checked~.tabbed-canvas-tabbar label[for=canvas-tab-crux],
#canvas-tab-concept_cloud:checked~.tabbed-canvas-tabbar label[for=canvas-tab-concept_cloud],
#canvas-tab-story:checked~.tabbed-canvas-tabbar label[for=canvas-tab-story],
#canvas-tab-host_guide:checked~.tabbed-canvas-tabbar label[for=canvas-tab-host_guide],
#canvas-tab-board_person:checked~.tabbed-canvas-tabbar label[for=canvas-tab-board_person]{color:var(--ink);border-bottom-color:var(--royal)}
#canvas-tab-crux:checked~[data-tab-panel=crux],
#canvas-tab-concept_cloud:checked~[data-tab-panel=concept_cloud],
#canvas-tab-story:checked~[data-tab-panel=story],
#canvas-tab-host_guide:checked~[data-tab-panel=host_guide],
#canvas-tab-board_person:checked~[data-tab-panel=board_person]{display:block}
.tabbed-crux{max-width:1000px;min-height:70vh;margin:0 auto;display:flex;flex-direction:column;justify-content:center}
.tabbed-story{max-width:1000px;margin:0 auto}
.tabbed-story-stack{display:grid;gap:30px}
.tabbed-story-slide{min-height:80vh;display:flex;flex-direction:column;justify-content:center;gap:24px}
.tabbed-story-slide h3{max-width:900px;margin:0;font-size:clamp(32px,4.6vw,48px);font-weight:500;letter-spacing:-.015em;line-height:1.12;text-wrap:balance}
.tabbed-story-evidence,.tabbed-story-slide .tabbed-slide-trace{max-width:620px}
.tabbed-host-guide{max-width:840px;min-height:70vh;margin:0 auto;display:flex;flex-direction:column;justify-content:center;gap:16px}
.tabbed-crux h1,.tabbed-story h2{max-width:900px;margin:0;font-weight:500;line-height:1.14;text-wrap:balance}
.tabbed-crux h1{font-size:clamp(32px,4.6vw,48px)}
.tabbed-story h2{font-size:clamp(24px,3.4vw,36px);letter-spacing:-.01em}
.tabbed-canvas-lede{max-width:620px;font-size:16px;line-height:1.45;color:var(--ink-soft)}
.tabbed-canvas-lede b{color:var(--ink);font-weight:500}
.tabbed-cloud{max-width:1060px;margin:0 auto;display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:center;padding:30px 0}
.tabbed-concept{background:var(--card);border:1px solid var(--hairline);padding:12px 13px;animation:tabbedFloat 7s ease-in-out infinite}
.tabbed-concept summary{list-style:none;cursor:pointer}
.tabbed-concept summary::-webkit-details-marker{display:none}
.tabbed-concept-xl{font-size:clamp(24px,2.8vw,34px);font-weight:600}
.tabbed-concept-l{font-size:22px;font-weight:500}
.tabbed-concept-m{font-size:16px;font-weight:500}
.tabbed-concept-s{font-size:12px;font-weight:400}
.tabbed-tilt-neg{transform:rotate(-1.2deg)}
.tabbed-tilt-pos{transform:rotate(1.2deg)}
.tabbed-traceable{border-bottom:1px dotted var(--royal)}
.tabbed-trace{margin-top:12px;max-width:520px}
.tabbed-quote{margin:12px 0;padding:15px 18px;border:1px solid var(--hairline);border-left:3px solid var(--royal);background:var(--card)}
.tabbed-quote p{margin:0;font-size:14px;line-height:1.45}
.tabbed-quote footer,.tabbed-host-item footer{margin-top:8px;font-size:11px;color:var(--ink-soft);font-variant-numeric:tabular-nums}
.tabbed-host-items{margin-top:22px;display:grid;gap:12px}
.tabbed-host-item{border:1px solid var(--hairline);border-left:3px solid var(--royal);background:var(--card);padding:15px 18px}
.tabbed-host-item p{margin:0;white-space:pre-wrap}
.tabbed-guide-block{border:1px solid var(--hairline);background:var(--card);padding:16px 18px}
.tabbed-guide-block h3{margin:0 0 10px;font-size:16px;font-weight:600}
.tabbed-guide-block p{margin:0;color:var(--ink-soft);line-height:1.45}
.tabbed-guide-block ol,.tabbed-guide-block ul{margin:0;padding-left:20px;color:var(--ink-soft);line-height:1.45}
.tabbed-guide-block li+li{margin-top:8px}
.tabbed-open-orient{margin:0;color:var(--ink-soft);font-size:16px;line-height:1.45;max-width:620px}
.tabbed-board{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:9px;align-items:stretch}
.tabbed-board-card{background:var(--card);border:1px solid var(--hairline);padding:12px 13px;min-height:150px;display:flex;flex-direction:column;gap:8px}
.tabbed-board-card h3{margin:0;font-size:14px;font-weight:700;line-height:1.2;color:var(--ink)}
.tabbed-board-card p{margin:0;font-size:13px;line-height:1.35;color:var(--ink-soft)}
.tabbed-board-trace{margin-top:auto}
.tabbed-board-trace summary{list-style:none;cursor:pointer;font-size:12px}
.tabbed-board-trace summary::-webkit-details-marker{display:none}
.tabbed-canvas-empty{color:var(--ink-soft)}
@keyframes tabbedFloat{0%,100%{translate:0 0}50%{translate:0 -5px}}
@media (prefers-reduced-motion:reduce){.tabbed-concept{animation:none}}
@media (max-width:1100px){.tabbed-board{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:720px){.tabbed-canvas-frame{padding:14px 14px 60px}.tabbed-canvas-tabbar{gap:16px}.tabbed-crux,.tabbed-story-slide,.tabbed-host-guide{min-height:58vh}.tabbed-board{grid-template-columns:1fr}}
"""
