from __future__ import annotations

from typing import Any

import pytest

from dembrane import chat_utils
from tests.llm_fakes import FakeCompletion


def _patch_completion(monkeypatch: pytest.MonkeyPatch, content: str | None) -> None:
    async def _fake(*_args: Any, **_kwargs: Any) -> FakeCompletion:
        return FakeCompletion(content)

    monkeypatch.setattr(chat_utils, "DISABLE_CHAT_TITLE_GENERATION", False)
    monkeypatch.setattr(chat_utils, "arouter_completion", _fake)


@pytest.mark.asyncio
async def test_generate_title_returns_none_when_model_call_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _fake(*_args: Any, **_kwargs: Any) -> FakeCompletion:
        raise RuntimeError("litellm.APIConnectionError: upstream unavailable")

    monkeypatch.setattr(chat_utils, "DISABLE_CHAT_TITLE_GENERATION", False)
    monkeypatch.setattr(chat_utils, "arouter_completion", _fake)

    assert await chat_utils.generate_title("what do people say about housing?", "en") is None


@pytest.mark.parametrize("content", [None, "", "   \n  ", "x" * 400])
@pytest.mark.asyncio
async def test_generate_title_rejects_unusable_content(
    monkeypatch: pytest.MonkeyPatch, content: str | None
) -> None:
    _patch_completion(monkeypatch, content)

    assert await chat_utils.generate_title("what do people say about housing?", "en") is None


@pytest.mark.parametrize(
    ("content", "expected"),
    [
        ("Housing Costs", "Housing Costs"),
        ('  "Housing Costs"  \n', "Housing Costs"),
        ("Here are some options:\n1. Housing Costs\n2. Rent Debate", "Housing Costs"),
        ("**Housing Costs**", "Housing Costs"),
        ("Warning signs of burnout", "Warning signs of burnout"),
    ],
)
@pytest.mark.asyncio
async def test_generate_title_cleans_model_output(
    monkeypatch: pytest.MonkeyPatch, content: str, expected: str
) -> None:
    _patch_completion(monkeypatch, content)

    assert await chat_utils.generate_title("what do people say about housing?", "en") == expected
