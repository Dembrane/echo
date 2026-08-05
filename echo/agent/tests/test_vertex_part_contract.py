"""Pins the langchain_google_vertexai assumption that _is_empty_ai_turn rests on.

Vertex rejects any request containing a Content with zero parts ("must include
at least one parts field") and that kills the whole stream. _is_empty_ai_turn
drops exactly the AI turns that would serialize that way, which means its
correctness depends on the connector's part-building, not on our own code. This
file asserts that dependency directly, so a connector upgrade that changes which
shapes produce parts fails here instead of in production.

The connector entry point is private. If an upgrade renames it these tests skip
rather than fail red, since a rename is not by itself a behavior change.
"""

from __future__ import annotations

from typing import Any

import pytest
from langchain_core.messages import AIMessage, ToolMessage, HumanMessage

from agent import _is_empty_ai_turn

_parse_chat_history_gemini = pytest.importorskip(
    "langchain_google_vertexai.chat_models"
).__dict__.get("_parse_chat_history_gemini")
ImageBytesLoader = pytest.importorskip("langchain_google_vertexai._image_utils").__dict__.get(
    "ImageBytesLoader"
)

pytestmark = pytest.mark.skipif(
    _parse_chat_history_gemini is None or ImageBytesLoader is None,
    reason="connector serializer moved; part-count contract cannot be checked",
)

# Shapes that serialize to zero parts, so Vertex 400s on them.
ZERO_PART_CONTENT: list[Any] = [
    "",
    [],
    [""],
    [{"type": "text", "text": ""}],
    [{"type": "function_call_signature", "signature": "YWJj", "index": 0}],
]

# Shapes that still carry a part, so dropping them would lose a real turn.
PART_BEARING_CONTENT: list[Any] = [
    "real answer",
    [{"type": "text", "text": "real answer"}],
    ["", {"type": "text", "text": "still says something"}],
]

# Deliberate over-strictness: the connector keeps whitespace as a part, we drop
# it anyway. A whitespace-only turn carries no information, so this loses
# nothing. Listed here so the mismatch stays intentional rather than accidental.
DROPPED_DESPITE_HAVING_A_PART: list[Any] = ["   ", ["  "]]


def _model_content_parts(content: Any) -> int:
    """Serialize an AI turn the way the connector would and count its parts.

    The turn follows a tool result so it starts its own model Content; appended
    after another model turn the connector would merge it and hide the problem.
    """
    history = [
        HumanMessage(content="hi"),
        AIMessage(content="", tool_calls=[{"id": "1", "name": "t", "args": {}}]),
        ToolMessage(content="result", tool_call_id="1", name="t"),
        AIMessage(content=content),
    ]
    result = _parse_chat_history_gemini(history, ImageBytesLoader())
    messages = result[1] if isinstance(result, tuple) else result
    last = messages[-1]
    assert last.role == "model", "expected the AI turn to be its own model Content"
    return len(last.parts)


@pytest.mark.parametrize("content", ZERO_PART_CONTENT, ids=repr)
def test_zero_part_shapes_are_still_zero_part(content: Any):
    assert _model_content_parts(content) == 0


@pytest.mark.parametrize("content", ZERO_PART_CONTENT, ids=repr)
def test_every_zero_part_shape_is_dropped_by_the_guard(content: Any):
    assert _is_empty_ai_turn(AIMessage(content=content)), (
        "this shape would 400 but the guard lets it through"
    )


@pytest.mark.parametrize("content", PART_BEARING_CONTENT, ids=repr)
def test_part_bearing_shapes_still_carry_a_part(content: Any):
    assert _model_content_parts(content) >= 1


@pytest.mark.parametrize("content", PART_BEARING_CONTENT, ids=repr)
def test_the_guard_keeps_every_part_bearing_shape(content: Any):
    assert not _is_empty_ai_turn(AIMessage(content=content)), (
        "the guard dropped a turn that Vertex would have accepted"
    )


@pytest.mark.parametrize("content", DROPPED_DESPITE_HAVING_A_PART, ids=repr)
def test_whitespace_only_content_is_dropped_on_purpose(content: Any):
    assert _model_content_parts(content) >= 1
    assert _is_empty_ai_turn(AIMessage(content=content))


def test_a_turn_with_tool_calls_is_never_dropped():
    """Tool calls always produce parts, and dropping one would orphan its
    ToolMessage."""
    message = AIMessage(content="", tool_calls=[{"id": "1", "name": "t", "args": {}}])
    assert _model_content_parts(message.content) == 0, "content alone is partless here"
    assert not _is_empty_ai_turn(message)


def test_unknown_block_types_are_assumed_to_render():
    """Fail-safe direction: an unrecognized block keeps the turn alive."""
    assert not _is_empty_ai_turn(AIMessage(content=[{"type": "some_future_block"}]))
