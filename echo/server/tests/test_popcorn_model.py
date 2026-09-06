from __future__ import annotations

import asyncio
from typing import Any

import pytest

import dembrane.popcorn.model as model
from dembrane.llms import MODELS


def test_popcorn_uses_the_platforms_fast_group() -> None:
    assert model.popcorn_model() is MODELS.MULTI_MODAL_FAST


def test_every_call_is_bounded(monkeypatch) -> None:
    async def _hangs(*args: Any, **kwargs: Any) -> Any:  # noqa: ARG001
        await asyncio.sleep(30)

    monkeypatch.setattr(model, "arouter_completion", _hangs)
    monkeypatch.setattr(model, "EXTRACT_TIMEOUT_SECONDS", 0.05)
    monkeypatch.setattr(model, "ENRICH_TIMEOUT_SECONDS", 0.05)
    monkeypatch.setattr(model, "ANALYSIS_TIMEOUT_SECONDS", 0.05)
    with pytest.raises(asyncio.TimeoutError):
        asyncio.run(model.extract_popcorn(transcript_id="t", transcript="x"))
    with pytest.raises(asyncio.TimeoutError):
        asyncio.run(model.validate_phrase(transcript_id="t", transcript="x", phrase="p"))
    with pytest.raises(asyncio.TimeoutError):
        asyncio.run(
            model.analysis_call(system_prompt="s", user_text="u", schema={"type": "object"})
        )


def test_prompts_are_the_versioned_snapshots() -> None:
    assert model.POPCORN_PROMPT == "popcorn-v1.7"
    assert "Version: `popcorn-v1.7`" in model.prompt_text(model.POPCORN_PROMPT)
    assert "weight" not in model.prompt_text(model.POPCORN_PROMPT).lower()
    assert "Version: `popcorn-validate-v1.1`" in model.prompt_text(model.VALIDATE_PROMPT)
    assert "Version: `popcorn-kind-v3`" in model.prompt_text(model.KIND_PROMPT)
    assert "Version: `popcorn-question-v1`" in model.prompt_text(model.QUESTION_PROMPT)
