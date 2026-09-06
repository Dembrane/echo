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


def test_a_cut_off_answer_says_why(monkeypatch) -> None:
    """Thinking that eats the answer budget comes back as JSON cut mid-string;
    the error names the finish reason and the token counts, and the analysis
    calls ask for the model's whole output ceiling."""
    from types import SimpleNamespace

    seen: dict[str, Any] = {}

    async def _cut(_group: Any, **kwargs: Any) -> Any:
        seen.update(kwargs)
        details = SimpleNamespace(reasoning_tokens=30719)
        usage = SimpleNamespace(completion_tokens=31986, completion_tokens_details=details)
        choice = SimpleNamespace(
            finish_reason="length",
            message=SimpleNamespace(content='{"positions": [{"position": "we should keep the'),
        )
        return SimpleNamespace(choices=[choice], usage=usage)

    monkeypatch.setattr(model, "arouter_completion", _cut)
    with pytest.raises(ValueError, match="finish_reason=length.*reasoning_tokens=30719"):
        asyncio.run(
            model.analysis_call(
                system_prompt="p", user_text="t", schema={"type": "object"}, thinking=True
            )
        )
    assert seen["max_tokens"] == 65536
