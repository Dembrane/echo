"""Model calls for popcorn, using the prompts exactly as versioned upstream.

The prompt files under `prompts/` are immutable snapshots copied from
Dembrane/popcorn (commit 7c3d1cf). A prompt iteration is a new file plus a
new version constant here, never an edit in place.
"""

from __future__ import annotations

import re
import json
import logging
from typing import Any
from pathlib import Path
from functools import lru_cache

from dembrane.llms import MODELS, arouter_completion
from dembrane.popcorn.analysis import POPCORN_SCHEMA, TENSIONS_SCHEMA, STAKEHOLDERS_SCHEMA

logger = logging.getLogger("dembrane.popcorn.model")

PROMPTS_DIR = Path(__file__).with_name("prompts")
POPCORN_PROMPT = "popcorn-v1.4"
TENSIONS_PROMPT = "tensions"
STAKEHOLDERS_PROMPT = "stakeholders"

ANALYSIS_SCHEMAS: dict[str, dict[str, Any]] = {
    "tensions": TENSIONS_SCHEMA,
    "stakeholders": STAKEHOLDERS_SCHEMA,
}
ANALYSIS_PROMPTS: dict[str, str] = {
    "tensions": TENSIONS_PROMPT,
    "stakeholders": STAKEHOLDERS_PROMPT,
}


@lru_cache(maxsize=8)
def prompt_text(name: str) -> str:
    return (PROMPTS_DIR / f"{name}.md").read_text(encoding="utf-8")


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


def _json_from_text(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    parsed = json.loads(cleaned)
    if not isinstance(parsed, dict):
        raise ValueError("Popcorn model response was not a JSON object")
    return parsed


def _transcript_message(transcript_id: str, transcript: str, host_note: str = "") -> str:
    note = (
        f"HOST NOTE ON VOICE (from the facilitator; every rule above still holds):\n{host_note}\n\n"
        if host_note
        else ""
    )
    return f"{note}Transcript id: {transcript_id}\n\nTRANSCRIPT START\n{transcript}\nTRANSCRIPT END"


async def _structured_completion(
    *,
    system_prompt: str,
    user_text: str,
    schema: dict[str, Any],
    max_tokens: int,
    fast: bool,
) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_text},
        ],
        "temperature": 0,
        "max_tokens": max_tokens,
        "response_format": {"type": "json_object", "response_schema": schema},
    }
    if fast:
        # The first pass is a latency product: thinking roughly triples time to
        # first phrase (10.6s -> 3.0s measured 31 Aug 2026 on gemini-3.7-flash).
        # thinkingConfig is passed through LiteLLM verbatim as a Gemini
        # generationConfig field, exactly as the upstream demo sends it.
        kwargs["thinkingConfig"] = {"thinkingBudget": 0}
    response = await arouter_completion(MODELS.MULTI_MODAL_FAST, **kwargs)
    return _json_from_text(_choice_text(response))


async def extract_popcorn(
    *, transcript_id: str, transcript: str, host_note: str = ""
) -> dict[str, Any]:
    """One fast extractor per transcript. Returns the raw `{items: [...]}`."""
    return await _structured_completion(
        system_prompt=prompt_text(POPCORN_PROMPT),
        user_text=_transcript_message(transcript_id, transcript, host_note),
        schema=POPCORN_SCHEMA,
        max_tokens=2000,
        fast=True,
    )


async def run_analysis(*, kind: str, corpus: str) -> dict[str, Any]:
    """One cross-conversation slide (tensions or stakeholders) over the whole session."""
    return await _structured_completion(
        system_prompt=prompt_text(ANALYSIS_PROMPTS[kind]),
        user_text=_transcript_message("session", corpus),
        schema=ANALYSIS_SCHEMAS[kind],
        # Gemini counts its thinking against maxOutputTokens, and the analysis
        # passes think by default, so a tight cap truncates the JSON mid-array.
        max_tokens=32000,
        fast=False,
    )
