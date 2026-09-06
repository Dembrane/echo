"""Model calls for popcorn, using the prompts exactly as versioned upstream.

The prompt files under `prompts/` are immutable snapshots copied from
Dembrane/popcorn (popcorn-v1.4 at commit 7c3d1cf; popcorn-v1.5, v1.6 and the
second-pass prompts at commit 8c23eba; popcorn-v1.7 is v1.6 without the
weight section, platform-side, September 5th 2026). A prompt iteration is a
new file plus a new version constant here, never an edit in place.

Every popcorn call goes through the platform's fast multimodal group
(`popcorn_model()`), bounded by a timeout per kind of call.
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
from dembrane.popcorn.analysis import POPCORN_SCHEMA, TENSIONS_SCHEMA, STAKEHOLDERS_SCHEMA
from dembrane.popcorn.enrichment import KIND_SCHEMA, QUESTION_SCHEMA, VALIDATE_SCHEMA

logger = logging.getLogger("dembrane.popcorn.model")

PROMPTS_DIR = Path(__file__).with_name("prompts")
POPCORN_PROMPT = "popcorn-v1.7"
VALIDATE_PROMPT = "popcorn-validate"
KIND_PROMPT = "popcorn-kind"
QUESTION_PROMPT = "popcorn-question"
TENSIONS_PROMPT = (
    "tensions"  # the single-call slide, kept for the record; the tick runs the pipeline
)
STAKEHOLDERS_PROMPT = "stakeholders-v0.9"

# Gemini counts its thinking against maxOutputTokens, and the analysis calls
# think by default, so a tight cap truncates the JSON mid-array.
# Gemini counts thinking against the answer budget, and a long table's
# exhaustive positions call thinks hard (30,719 reasoning tokens on a
# 97,000-character transcript, gemini-2.5-flash, September 6th 2026): at
# 32,000 the answer was cut mid-string. 65,536 is the model's own ceiling.
ANALYSIS_MAX_TOKENS = 65536

# The second pass thinks, and Gemini counts thinking against the output cap.
ENRICH_MAX_TOKENS = 8000

# Every call is bounded. The fast pass answers in seconds (thinking off); the
# second pass thinks; the analysis calls carry their callers' longer bounds
# as well (tensions 240 s, stakeholders 300 s), this is the backstop.
EXTRACT_TIMEOUT_SECONDS = 60
ENRICH_TIMEOUT_SECONDS = 120
ANALYSIS_TIMEOUT_SECONDS = 300


def popcorn_model() -> MODELS:
    """The group every popcorn call uses: the platform's fast multimodal
    group, the same deployment as everything else that reads transcripts."""
    return MODELS.MULTI_MODAL_FAST


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
    timeout: float,
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
    response = await asyncio.wait_for(
        arouter_completion(popcorn_model(), **kwargs), timeout=timeout
    )
    text = _choice_text(response)
    try:
        return _json_from_text(text)
    except ValueError as exc:
        # A cut-off answer (finish_reason "length": the budget went to
        # thinking) reads as a JSON error; the log should say which it was.
        raise ValueError(
            f"model answer did not parse ({_answer_facts(response, text)}): {exc}"
        ) from exc


def _answer_facts(response: Any, text: str) -> str:
    """finish_reason and the token counts, for a log line about a bad answer."""
    try:
        finish = response.choices[0].finish_reason
    except Exception:
        finish = None
    usage = getattr(response, "usage", None)
    completion = getattr(usage, "completion_tokens", None)
    details = getattr(usage, "completion_tokens_details", None)
    reasoning = getattr(details, "reasoning_tokens", None)
    return (
        f"finish_reason={finish}, {len(text)} chars, "
        f"completion_tokens={completion}, reasoning_tokens={reasoning}"
    )


def _phrase_message(transcript_id: str, transcript: str, phrase: str, label: str) -> str:
    return f"TRANSCRIPT id: {transcript_id}\n{transcript}\nEND TRANSCRIPT\n\n{label}:\n{phrase}"


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
        timeout=EXTRACT_TIMEOUT_SECONDS,
    )


async def validate_phrase(*, transcript_id: str, transcript: str, phrase: str) -> dict[str, Any]:
    """Second pass, one phrase: the verbatim passage it paraphrases, or grounded false."""
    return await _structured_completion(
        system_prompt=prompt_text(VALIDATE_PROMPT),
        user_text=_phrase_message(transcript_id, transcript, phrase, "POPCORN PHRASE"),
        schema=VALIDATE_SCHEMA,
        max_tokens=ENRICH_MAX_TOKENS,
        fast=False,
        timeout=ENRICH_TIMEOUT_SECONDS,
    )


async def classify_phrase(*, transcript_id: str, transcript: str, phrase: str) -> dict[str, Any]:
    """Second pass, one phrase: its kind, qualifiers and whether it is a question in form."""
    return await _structured_completion(
        system_prompt=prompt_text(KIND_PROMPT),
        user_text=_phrase_message(transcript_id, transcript, phrase, "PHRASE"),
        schema=KIND_SCHEMA,
        max_tokens=ENRICH_MAX_TOKENS,
        fast=False,
        timeout=ENRICH_TIMEOUT_SECONDS,
    )


async def rewrite_question(*, transcript_id: str, transcript: str, phrase: str) -> dict[str, Any]:
    """A question-kind phrase written as a statement, rewritten as the question asked."""
    return await _structured_completion(
        system_prompt=prompt_text(QUESTION_PROMPT),
        user_text=_phrase_message(
            transcript_id, transcript, phrase, "POPCORN PHRASE (written as a statement)"
        ),
        schema=QUESTION_SCHEMA,
        max_tokens=ENRICH_MAX_TOKENS,
        fast=False,
        timeout=ENRICH_TIMEOUT_SECONDS,
    )


async def analysis_call(
    *, system_prompt: str, user_text: str, schema: dict[str, Any], thinking: bool = True
) -> dict[str, Any]:
    """One judgement of the analysis kind: the caller brings the prompt and the
    schema; the model thinks unless told not to."""
    return await _structured_completion(
        system_prompt=system_prompt,
        user_text=user_text,
        schema=schema,
        max_tokens=ANALYSIS_MAX_TOKENS,
        fast=not thinking,
        timeout=ANALYSIS_TIMEOUT_SECONDS,
    )


async def run_analysis(
    *, kind: str, corpus: str, feedback: list[str] | None = None
) -> dict[str, Any]:
    """One cross-conversation slide over the whole session. `feedback` is the
    list of deterministic checks a previous answer failed; the prompt goes
    back with them appended, once."""
    system = prompt_text(ANALYSIS_PROMPTS[kind])
    if feedback:
        lines = "".join(f"- {f}\n" for f in feedback)
        system = (
            f"{system}\n\n## Your previous answer failed these checks\n\n{lines}"
            "\nFix every one of them and return the complete output again."
        )
    return await _structured_completion(
        system_prompt=system,
        user_text=_transcript_message("session", corpus),
        schema=ANALYSIS_SCHEMAS[kind],
        max_tokens=ANALYSIS_MAX_TOKENS,
        fast=False,
        timeout=ANALYSIS_TIMEOUT_SECONDS,
    )
