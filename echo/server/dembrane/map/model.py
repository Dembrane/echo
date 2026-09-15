"""Model calls for Map: extraction, selection titles and fact-checks.

Every call goes through the platform's fast multimodal group, the same
deployment as the other features that read transcripts, via the LiteLLM router
(which retries and fails over between deployments). A prompt iteration is a new
file and a new version constant, never an edit in place, so a saved result can
name the prompt that produced it.
"""

from __future__ import annotations

import re
import json
import asyncio
import logging
from typing import Any
from pathlib import Path
from functools import lru_cache

from dembrane.llms import MODELS, arouter_completion
from dembrane.settings import get_settings

logger = logging.getLogger("dembrane.map.model")

MODEL_GROUP = MODELS.MULTI_MODAL_FAST
PROMPTS_DIR = Path(__file__).with_name("prompts")

EXTRACTION_PROMPT = "map-arguments-v1"
TITLE_PROMPT = "map-title-v1"
FACTCHECK_INVESTIGATE_PROMPT = "map-factcheck-investigate-v1"
FACTCHECK_CLASSIFY_PROMPT = "map-factcheck-classify-v1"
FACTCHECK_PROMPT_VERSION = f"{FACTCHECK_INVESTIGATE_PROMPT}+{FACTCHECK_CLASSIFY_PROMPT}"

# Gemini counts its thinking against max_tokens: an extraction of a long window
# thinks and then writes many full statements, so the cap is generous.
EXTRACTION_MAX_TOKENS = 32_000
EXTRACTION_TIMEOUT_SECONDS = 300
# One retry on top of the router's own retries, for answers that did not parse
# or a call that timed out.
EXTRACTION_ATTEMPTS = 2
TITLE_MAX_TOKENS = 2_048
TITLE_TIMEOUT_SECONDS = 60
FACTCHECK_MAX_TOKENS = 4_096
FACTCHECK_TIMEOUT_SECONDS = 180
MAX_SOURCES = 5

ARGUMENTS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["items"],
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["kind", "statement", "evidence", "valence"],
                "properties": {
                    "kind": {"type": "string", "enum": ["argument", "claim"]},
                    "statement": {"type": "string", "minLength": 1},
                    # Nested maxItems makes Vertex reject the whole schema.
                    "evidence": {
                        "type": "array",
                        "minItems": 1,
                        "items": {"type": "string", "minLength": 1},
                    },
                    "valence": {"type": "string", "enum": ["positive", "negative", "neutral"]},
                },
            },
        }
    },
}

FACTCHECK_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["verdict", "justification"],
    "properties": {
        "verdict": {"type": "string", "enum": ["true", "false", "contested", "unknown"]},
        "justification": {"type": "string", "minLength": 1},
    },
}


def model_identity() -> str:
    return get_settings().llms.multi_modal_fast.model or MODEL_GROUP.value


@lru_cache(maxsize=8)
def prompt_text(name: str) -> str:
    return (PROMPTS_DIR / f"{name}.md").read_text(encoding="utf-8")


def choice_text(response: Any) -> str:
    try:
        content = response.choices[0].message.content
    except Exception:
        content = None
    if isinstance(content, str):
        return content
    if isinstance(response, dict):
        return ((response.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    return ""


def json_from_text(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        start, end = cleaned.find("{"), cleaned.rfind("}")
        if start < 0 or end <= start:
            raise
        parsed = json.loads(cleaned[start : end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("model answer was not a JSON object")
    return parsed


def usage_of(response: Any) -> dict[str, int]:
    usage = getattr(response, "usage", None)
    if usage is None and isinstance(response, dict):
        usage = response.get("usage")
    out: dict[str, int] = {}
    for name in ("prompt_tokens", "completion_tokens", "total_tokens"):
        value = usage.get(name) if isinstance(usage, dict) else getattr(usage, name, None)
        if isinstance(value, int):
            out[name] = value
    return out


def _finish_facts(response: Any, text: str) -> str:
    try:
        finish = response.choices[0].finish_reason
    except Exception:
        finish = None
    return f"finish_reason={finish}, {len(text)} chars, usage={usage_of(response)}"


async def extract_arguments(
    *, conversation_id: str, window: str, window_index: int, window_count: int
) -> tuple[dict[str, Any], dict[str, int]]:
    """One extraction call over one transcript window.

    Returns the raw `{items: [...]}` and the provider's token usage. Retries
    once on a timeout or an answer that does not parse."""
    part = f"Part {window_index + 1} of {window_count}.\n" if window_count > 1 else ""
    user_text = (
        f"Conversation id: {conversation_id}\n{part}\n"
        f"TRANSCRIPT START\n{window}\nTRANSCRIPT END"
    )
    last_error: Exception | None = None
    for attempt in range(1, EXTRACTION_ATTEMPTS + 1):
        try:
            response = await asyncio.wait_for(
                arouter_completion(
                    MODEL_GROUP,
                    messages=[
                        {"role": "system", "content": prompt_text(EXTRACTION_PROMPT)},
                        {"role": "user", "content": user_text},
                    ],
                    temperature=0,
                    max_tokens=EXTRACTION_MAX_TOKENS,
                    response_format={"type": "json_object", "response_schema": ARGUMENTS_SCHEMA},
                ),
                timeout=EXTRACTION_TIMEOUT_SECONDS,
            )
            text = choice_text(response)
            try:
                return json_from_text(text), usage_of(response)
            except ValueError as exc:
                raise ValueError(f"answer did not parse ({_finish_facts(response, text)})") from exc
        except (ValueError, TimeoutError, asyncio.TimeoutError) as exc:
            last_error = exc
            logger.warning(
                "map extraction attempt %d/%d failed for conversation %s window %d: %s",
                attempt,
                EXTRACTION_ATTEMPTS,
                conversation_id,
                window_index,
                exc,
            )
            if attempt < EXTRACTION_ATTEMPTS:
                await asyncio.sleep(2 * attempt)
    assert last_error is not None
    raise last_error


async def title_selection(*, lines: list[str], project_name: str, project_context: str) -> str:
    """A one-sentence title for a settled selection, from every selected line."""
    header = ""
    if project_name.strip():
        header += f"Project: {project_name.strip()}\n"
    if project_context.strip():
        header += f"Project Context: {project_context.strip()}\n"
    user_text = (
        f"{header}\nArguments in cluster (sorted by relevance):\n"
        + "\n".join(lines)
        + "\n\nDistill the core idea into one clear, concise sentence (8-15 words) "
        "that captures what makes this cluster unique within the project context."
    )
    response = await asyncio.wait_for(
        arouter_completion(
            MODEL_GROUP,
            messages=[
                {"role": "system", "content": prompt_text(TITLE_PROMPT)},
                {"role": "user", "content": user_text},
            ],
            temperature=0,
            max_tokens=TITLE_MAX_TOKENS,
            # A title follows the analyst's cursor, so it is a latency product
            # like popcorn's first pass: thinking off, passed through LiteLLM
            # verbatim as a Gemini generationConfig field.
            thinkingConfig={"thinkingBudget": 0},
        ),
        timeout=TITLE_TIMEOUT_SECONDS,
    )
    lines_out = [line.strip() for line in choice_text(response).splitlines() if line.strip()]
    title = " ".join((lines_out[0] if lines_out else "").strip("\"'“”").split())
    if not title:
        raise ValueError("the title answer was empty")
    return title


def _field(value: Any, *names: str) -> Any:
    for name in names:
        if isinstance(value, dict) and name in value:
            return value[name]
        found = getattr(value, name, None)
        if found is not None:
            return found
    return None


def grounding_sources(response: Any) -> list[dict[str, str]]:
    """The Google Search citations LiteLLM exposes for a grounded answer."""
    choices = _field(response, "choices") or []
    message = _field(choices[0], "message") if choices else None
    metadata = _field(message, "grounding_metadata", "groundingMetadata") or _field(
        response, "vertex_ai_grounding_metadata", "grounding_metadata", "groundingMetadata"
    )
    if isinstance(metadata, list):
        metadata = metadata[0] if metadata else None
    if metadata is None:
        provider_fields = _field(message, "provider_specific_fields") or {}
        metadata = _field(provider_fields, "grounding_metadata", "groundingMetadata")
    chunks = _field(metadata, "grounding_chunks", "groundingChunks") or []
    sources: list[dict[str, str]] = []
    seen: set[str] = set()
    for chunk in chunks:
        web = _field(chunk, "web")
        uri = str(_field(web, "uri") or "").strip()
        if not uri or uri in seen:
            continue
        seen.add(uri)
        sources.append({"url": uri, "title": str(_field(web, "title") or uri).strip()})
        if len(sources) == MAX_SOURCES:
            break
    return sources


async def factcheck_claim(
    *, statement: str, evidence: list[str], project_name: str, project_context: str
) -> dict[str, Any]:
    """Investigate a claim with Search grounding, then classify the finding."""
    header = []
    if project_name.strip():
        header.append(f"PROJECT: {project_name.strip()}")
    if project_context.strip():
        header.append(f"PROJECT CONTEXT: {project_context.strip()}")
    user_text = "\n".join(
        [
            *header,
            *([""] if header else []),
            f"CLAIM: {statement}",
            "",
            "CONTEXT (speaker's own words: do not fact-check these, use them only "
            "to understand what the speaker meant):",
            *(f'- "{quote}"' for quote in evidence),
        ]
    )
    investigation = await asyncio.wait_for(
        arouter_completion(
            MODEL_GROUP,
            messages=[
                {"role": "system", "content": prompt_text(FACTCHECK_INVESTIGATE_PROMPT)},
                {"role": "user", "content": user_text},
            ],
            tools=[{"googleSearch": {}}],
            temperature=0,
            max_tokens=FACTCHECK_MAX_TOKENS,
        ),
        timeout=FACTCHECK_TIMEOUT_SECONDS,
    )
    analysis = choice_text(investigation).strip()
    if not analysis:
        raise ValueError("the fact-check investigation came back empty")
    classification = await asyncio.wait_for(
        arouter_completion(
            MODEL_GROUP,
            messages=[
                {"role": "system", "content": prompt_text(FACTCHECK_CLASSIFY_PROMPT)},
                {"role": "user", "content": f"CLAIM: {statement}\n\nANALYSIS:\n{analysis}"},
            ],
            temperature=0,
            max_tokens=FACTCHECK_MAX_TOKENS,
            response_format={"type": "json_object", "response_schema": FACTCHECK_SCHEMA},
        ),
        timeout=FACTCHECK_TIMEOUT_SECONDS,
    )
    verdict = "unknown"
    justification = analysis
    try:
        parsed = json_from_text(choice_text(classification))
        if parsed.get("verdict") in {"true", "false", "contested", "unknown"}:
            verdict = str(parsed["verdict"])
        if isinstance(parsed.get("justification"), str) and parsed["justification"].strip():
            justification = parsed["justification"].strip()
    except (ValueError, json.JSONDecodeError) as exc:
        # The prototype's fallback: the analysis stands in for the justification.
        logger.warning("map fact-check classification did not parse: %s", exc)
    return {
        "verdict": verdict,
        "justification": " ".join(justification.split()),
        "sources": grounding_sources(investigation),
    }
