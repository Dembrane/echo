from __future__ import annotations

from typing import Any

import pytest

from dembrane import chat_utils


class _Message:
    def __init__(self, content: str | None) -> None:
        self.content = content


class _Choice:
    def __init__(self, content: str | None) -> None:
        self.message = _Message(content)


class _Response:
    def __init__(self, content: str | None) -> None:
        self.choices = [_Choice(content)]


def _patch_completion(monkeypatch: pytest.MonkeyPatch, content: str | None) -> None:
    async def _fake(*_args: Any, **_kwargs: Any) -> _Response:
        return _Response(content)

    monkeypatch.setattr(chat_utils, "arouter_completion", _fake)


@pytest.mark.asyncio
async def test_generate_title_returns_none_when_model_call_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _fake(*_args: Any, **_kwargs: Any) -> _Response:
        raise RuntimeError("litellm.APIConnectionError: upstream unavailable")

    monkeypatch.setattr(chat_utils, "arouter_completion", _fake)

    assert await chat_utils.generate_title("what do people say about housing?", "en") is None


@pytest.mark.parametrize(
    "content",
    [
        "litellm.APIConnectionError: deployment multi_modal_fast failed",
        "Error: 500 Internal Server Error from provider",
        "I'm sorry, I can't help with generating a title for that.",
        "x" * 400,
    ],
)
@pytest.mark.asyncio
async def test_generate_title_rejects_error_shaped_content(
    monkeypatch: pytest.MonkeyPatch, content: str
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
    ],
)
@pytest.mark.asyncio
async def test_generate_title_cleans_model_output(
    monkeypatch: pytest.MonkeyPatch, content: str, expected: str
) -> None:
    _patch_completion(monkeypatch, content)

    assert await chat_utils.generate_title("what do people say about housing?", "en") == expected
