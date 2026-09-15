"""Map's model calls, with the router stubbed: retries, fallbacks, citations."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from dembrane.map import model
from tests.llm_fakes import FakeCompletion


class _Router:
    """Answers from a script: a string becomes a completion, an exception is raised."""

    def __init__(self, *answers: Any) -> None:
        self.answers = list(answers)
        self.calls: list[dict[str, Any]] = []

    async def __call__(self, model_group: Any, **kwargs: Any) -> Any:
        self.calls.append({"model_group": model_group, **kwargs})
        answer = self.answers.pop(0)
        if isinstance(answer, BaseException):
            raise answer
        return FakeCompletion(answer) if isinstance(answer, str) else answer


@pytest.fixture
def sleeps(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    recorded: list[float] = []
    real_sleep = asyncio.sleep

    async def _sleep(seconds: float, *args: Any, **kwargs: Any) -> Any:
        recorded.append(seconds)
        return await real_sleep(0, *args, **kwargs)

    monkeypatch.setattr(model.asyncio, "sleep", _sleep)
    return recorded


async def _extract() -> tuple[dict[str, Any], dict[str, int]]:
    return await model.extract_arguments(
        conversation_id="c1", window="Ann: trams please", window_index=0, window_count=1
    )


@pytest.mark.asyncio
async def test_extraction_retries_once_when_the_first_answer_does_not_parse(
    monkeypatch: pytest.MonkeyPatch, sleeps: list[float]
) -> None:
    usage_answer = FakeCompletion('```json\n{"items": [{"kind": "argument"}]}\n```')
    usage_answer.usage = {"prompt_tokens": 7, "completion_tokens": 3, "total_tokens": 10}  # type: ignore[attr-defined]
    router = _Router("I think the arguments are", usage_answer)
    monkeypatch.setattr(model, "arouter_completion", router)

    raw, usage = await _extract()

    assert raw == {"items": [{"kind": "argument"}]}
    assert usage == {"prompt_tokens": 7, "completion_tokens": 3, "total_tokens": 10}
    assert len(router.calls) == 2
    assert sleeps == [2]
    assert router.calls[0]["model_group"] == model.MODEL_GROUP
    assert "TRANSCRIPT START\nAnn: trams please\nTRANSCRIPT END" in router.calls[0]["messages"][1]["content"]


@pytest.mark.asyncio
async def test_extraction_retries_after_a_timeout(
    monkeypatch: pytest.MonkeyPatch, sleeps: list[float]
) -> None:
    router = _Router(asyncio.TimeoutError(), '{"items": []}')
    monkeypatch.setattr(model, "arouter_completion", router)

    assert (await _extract())[0] == {"items": []}
    assert len(router.calls) == 2 and sleeps == [2]


@pytest.mark.asyncio
async def test_extraction_raises_after_two_failed_answers(
    monkeypatch: pytest.MonkeyPatch, sleeps: list[float]
) -> None:
    router = _Router("nope", "[1, 2, 3]")
    monkeypatch.setattr(model, "arouter_completion", router)

    with pytest.raises(ValueError):
        await _extract()
    assert len(router.calls) == model.EXTRACTION_ATTEMPTS == 2
    assert sleeps == [2]


@pytest.mark.asyncio
async def test_extraction_does_not_retry_other_errors(
    monkeypatch: pytest.MonkeyPatch, sleeps: list[float]
) -> None:
    router = _Router(RuntimeError("router gave up"), '{"items": []}')
    monkeypatch.setattr(model, "arouter_completion", router)

    with pytest.raises(RuntimeError):
        await _extract()
    assert len(router.calls) == 1 and sleeps == []


async def _factcheck() -> dict[str, Any]:
    return await model.factcheck_claim(
        statement="The bridge opened in 1932.",
        evidence=["it opened in 1932"],
        project_name="Harbour",
        project_context="A city plan.",
    )


@pytest.mark.asyncio
async def test_factcheck_falls_back_to_unknown_with_the_analysis_when_classification_is_bad(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    router = _Router("The bridge opened\n in   1934, not 1932.", "verdict: false (sorry, no JSON)")
    monkeypatch.setattr(model, "arouter_completion", router)

    outcome = await _factcheck()

    assert outcome == {
        "verdict": "unknown",
        "justification": "The bridge opened in 1934, not 1932.",
        "sources": [],
    }
    assert router.calls[0]["tools"] == [{"googleSearch": {}}]
    assert "CLAIM: The bridge opened in 1932." in router.calls[0]["messages"][1]["content"]
    assert "PROJECT: Harbour" in router.calls[0]["messages"][1]["content"]


@pytest.mark.asyncio
async def test_factcheck_uses_a_valid_classification(monkeypatch: pytest.MonkeyPatch) -> None:
    router = _Router("Records say 1934.", '{"verdict": "false", "justification": " It opened in 1934. "}')
    monkeypatch.setattr(model, "arouter_completion", router)

    assert await _factcheck() == {
        "verdict": "false",
        "justification": "It opened in 1934.",
        "sources": [],
    }


@pytest.mark.asyncio
async def test_factcheck_ignores_an_unknown_verdict_value(monkeypatch: pytest.MonkeyPatch) -> None:
    router = _Router("Unclear.", '{"verdict": "probably", "justification": "Sources disagree."}')
    monkeypatch.setattr(model, "arouter_completion", router)

    outcome = await _factcheck()
    assert outcome["verdict"] == "unknown"
    assert outcome["justification"] == "Sources disagree."


@pytest.mark.asyncio
async def test_an_empty_investigation_is_an_error_not_a_verdict(monkeypatch: pytest.MonkeyPatch) -> None:
    router = _Router("   ")
    monkeypatch.setattr(model, "arouter_completion", router)

    with pytest.raises(ValueError):
        await _factcheck()
    assert len(router.calls) == 1


# ── grounding citations ─────────────────────────────────────────────────


def _chunks(*pairs: tuple[str, str | None], camel: bool = False) -> list[dict[str, Any]]:
    out = []
    for uri, title in pairs:
        web: dict[str, Any] = {"uri": uri}
        if title is not None:
            web["title"] = title
        out.append({"web": web})
    return out


class _Obj:
    def __init__(self, **fields: Any) -> None:
        self.__dict__.update(fields)


def test_grounding_sources_from_message_grounding_metadata_dict() -> None:
    response = {
        "choices": [
            {
                "message": {
                    "content": "analysis",
                    "grounding_metadata": {
                        "grounding_chunks": _chunks(("https://a.example", "A"), ("https://b.example", None))
                    },
                }
            }
        ]
    }
    assert model.grounding_sources(response) == [
        {"url": "https://a.example", "title": "A"},
        {"url": "https://b.example", "title": "https://b.example"},
    ]


def test_grounding_sources_from_vertex_metadata_list_on_the_response() -> None:
    response = _Obj(
        choices=[_Obj(message=_Obj(content="analysis"))],
        vertex_ai_grounding_metadata=[
            {"groundingChunks": _chunks(("https://c.example", "C"), ("", "no uri"), ("https://c.example", "dup"))}
        ],
    )
    assert model.grounding_sources(response) == [{"url": "https://c.example", "title": "C"}]


def test_grounding_sources_from_provider_specific_fields() -> None:
    message = _Obj(
        content="analysis",
        provider_specific_fields={"groundingMetadata": {"groundingChunks": _chunks(("https://d.example", "D"))}},
    )
    response = _Obj(choices=[_Obj(message=message)])
    assert model.grounding_sources(response) == [{"url": "https://d.example", "title": "D"}]


def test_grounding_sources_cap_at_five_unique_urls() -> None:
    pairs = [(f"https://s{i}.example", f"S{i}") for i in range(4)]
    pairs.insert(1, ("https://s0.example", "again"))
    pairs += [(f"https://t{i}.example", f"T{i}") for i in range(3)]
    response = {"choices": [{"message": {"grounding_metadata": {"grounding_chunks": _chunks(*pairs)}}}]}

    sources = model.grounding_sources(response)

    assert len(sources) == model.MAX_SOURCES == 5
    assert [s["url"] for s in sources] == [
        "https://s0.example",
        "https://s1.example",
        "https://s2.example",
        "https://s3.example",
        "https://t0.example",
    ]


def test_grounding_sources_without_metadata_is_empty() -> None:
    assert model.grounding_sources(FakeCompletion("plain")) == []
    assert model.grounding_sources({"choices": []}) == []
