"""The add-context token budget is correct for deep_dive (which preloads full
transcripts into the prompt) but wrong for agentic (which preloads nothing and
only uses the attached rows as a focus hint). Agentic must bypass the
MAX_CHAT_CONTEXT_LENGTH gate; deep_dive must keep it exactly as before.

chat_mode=None is the case the product actually produces: /v2/bff/chats creates
a chat with no mode, so anything that attaches before initialize-mode runs sees
NULL. It must be treated as deep_dive (gated), never as agentic.

The batch path (conversation_ids) walks one running budget server-side and adds
as much as fits, so the same rules apply to it and it reports a reason per
conversation instead of failing the whole batch.
"""

from typing import Optional
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

import dembrane.api.chat as chat_api
from dembrane.api.dependency_auth import DirectusSession


def _auth() -> DirectusSession:
    return DirectusSession(
        user_id="user-1",
        is_admin=True,
        access_token="token-1",
    )


class _FakeConversationService:
    def get_by_id_or_raise(self, *_args, **_kwargs):  # noqa: ANN002, ANN003
        return {"id": "conv-1"}


class _FakeChatService:
    def __init__(self) -> None:
        self.attach_calls: list[tuple[str, list[str]]] = []

    def attach_conversations(self, chat_id: str, conversation_ids: list[str]) -> None:
        self.attach_calls.append((chat_id, conversation_ids))


async def _fake_run_in_thread_pool(func, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003
    return func(*args, **kwargs)


def _chat_row(chat_mode: Optional[str]) -> dict:
    return {
        "id": "chat-1",
        "chat_mode": chat_mode,
        "project_id": {"id": "project-1"},
        "used_conversations": [],
    }


@pytest.fixture(autouse=True)
def _common_patches(monkeypatch):
    monkeypatch.setattr(chat_api, "run_in_thread_pool", _fake_run_in_thread_pool)
    monkeypatch.setattr(chat_api, "conversation_service", _FakeConversationService())
    monkeypatch.setattr(chat_api.async_directus, "get_item", AsyncMock(return_value=None))


@pytest.mark.asyncio
async def test_add_context_deep_dive_rejects_over_budget_conversation(monkeypatch) -> None:
    """Unchanged behaviour: deep_dive still gates on MAX_CHAT_CONTEXT_LENGTH."""

    async def _fake_raise_if_chat_not_found_or_not_authorized(*_args, **_kwargs):  # noqa: ANN002, ANN003
        return _chat_row("deep_dive")

    monkeypatch.setattr(
        chat_api,
        "raise_if_chat_not_found_or_not_authorized",
        _fake_raise_if_chat_not_found_or_not_authorized,
    )
    token_count_mock = AsyncMock(return_value=chat_api.MAX_CHAT_CONTEXT_LENGTH + 1)
    monkeypatch.setattr(chat_api, "get_conversation_token_count", token_count_mock)

    with pytest.raises(HTTPException) as exc:
        await chat_api.add_chat_context(
            chat_id="chat-1",
            body=chat_api.ChatAddContextSchema(
                conversation_id="conv-1",
                project_id="project-1",
            ),
            auth=_auth(),
        )

    assert exc.value.status_code == 400
    assert exc.value.detail == "Conversation is too long"
    token_count_mock.assert_awaited_once()


@pytest.mark.asyncio
async def test_add_context_agentic_skips_token_budget(monkeypatch) -> None:
    """Agentic preloads nothing, so the same over-budget conversation must be
    attached without ever touching the token-count check."""

    async def _fake_raise_if_chat_not_found_or_not_authorized(*_args, **_kwargs):  # noqa: ANN002, ANN003
        return _chat_row("agentic")

    monkeypatch.setattr(
        chat_api,
        "raise_if_chat_not_found_or_not_authorized",
        _fake_raise_if_chat_not_found_or_not_authorized,
    )
    token_count_mock = AsyncMock(return_value=chat_api.MAX_CHAT_CONTEXT_LENGTH + 1)
    monkeypatch.setattr(chat_api, "get_conversation_token_count", token_count_mock)
    get_chat_context_mock = AsyncMock()
    monkeypatch.setattr(chat_api, "get_chat_context", get_chat_context_mock)
    fake_chat_service = _FakeChatService()
    monkeypatch.setattr(chat_api, "chat_service", fake_chat_service)

    response = await chat_api.add_chat_context(
        chat_id="chat-1",
        body=chat_api.ChatAddContextSchema(
            conversation_id="conv-1",
            project_id="project-1",
        ),
        auth=_auth(),
    )

    assert isinstance(response, chat_api.AddContextResponseSchema)
    token_count_mock.assert_not_awaited()
    get_chat_context_mock.assert_not_awaited()
    assert fake_chat_service.attach_calls == [("chat-1", ["conv-1"])]


class _FakeConversationServiceWithList(_FakeConversationService):
    """Adds the id-scoped lookup the conversation_ids path uses."""

    def __init__(self, conversations: list[dict]) -> None:
        self.conversations = conversations
        self.list_calls: list[dict] = []

    def list_by_project_with_filters(self, **kwargs):  # noqa: ANN003, ANN201
        self.list_calls.append(kwargs)
        requested = kwargs.get("conversation_ids")
        if requested is None:
            return list(self.conversations)
        wanted = set(requested)
        return [c for c in self.conversations if c["id"] in wanted]


def _conv(conv_id: str) -> dict:
    return {"id": conv_id, "participant_name": f"P-{conv_id}", "is_over_cap": False}


def _patch_batch_deps(
    monkeypatch,
    *,
    chat_mode,
    conversations: list[dict],
    token_counts: dict,
    existing_usage: float = 0.0,
) -> _FakeChatService:
    """Wire up everything _attach_conversations_within_budget touches."""

    async def _fake_raise_if_chat_not_found_or_not_authorized(*_args, **_kwargs):  # noqa: ANN002, ANN003
        return _chat_row(chat_mode)

    monkeypatch.setattr(
        chat_api,
        "raise_if_chat_not_found_or_not_authorized",
        _fake_raise_if_chat_not_found_or_not_authorized,
    )
    monkeypatch.setattr(
        chat_api, "conversation_service", _FakeConversationServiceWithList(conversations)
    )
    fake_chat_service = _FakeChatService()
    monkeypatch.setattr(chat_api, "chat_service", fake_chat_service)
    monkeypatch.setattr(chat_api, "_resolve_workspace_tier", AsyncMock(return_value="innovator"))
    # Every candidate has transcript content.
    monkeypatch.setattr(
        chat_api.async_directus,
        "get_items",
        AsyncMock(
            return_value=[{"conversation_id": c["id"], "count": {"id": 1}} for c in conversations]
        ),
    )
    monkeypatch.setattr(
        chat_api,
        "get_chat_context",
        AsyncMock(
            return_value=chat_api.ChatContextSchema(
                conversations=[
                    chat_api.ChatContextConversationSchema(
                        conversation_id="already-there",
                        conversation_participant_name="Existing",
                        locked=False,
                        token_usage=existing_usage,
                    )
                ]
                if existing_usage
                else [],
                messages=[],
                conversation_id_list=[],
                locked_conversation_id_list=[],
                chat_mode=chat_mode,
            )
        ),
    )
    monkeypatch.setattr(
        chat_api, "get_conversation_token_counts_bulk", AsyncMock(return_value=token_counts)
    )
    return fake_chat_service


@pytest.mark.asyncio
async def test_add_context_mode_none_is_gated_like_deep_dive(monkeypatch) -> None:
    """The product creates chats with chat_mode NULL and sets the mode after, so
    NULL must fall on the gated side of the bypass, not the agentic side."""

    async def _fake_raise_if_chat_not_found_or_not_authorized(*_args, **_kwargs):  # noqa: ANN002, ANN003
        return _chat_row(None)

    monkeypatch.setattr(
        chat_api,
        "raise_if_chat_not_found_or_not_authorized",
        _fake_raise_if_chat_not_found_or_not_authorized,
    )
    token_count_mock = AsyncMock(return_value=chat_api.MAX_CHAT_CONTEXT_LENGTH + 1)
    monkeypatch.setattr(chat_api, "get_conversation_token_count", token_count_mock)

    with pytest.raises(HTTPException) as exc:
        await chat_api.add_chat_context(
            chat_id="chat-1",
            body=chat_api.ChatAddContextSchema(
                conversation_id="conv-1",
                project_id="project-1",
            ),
            auth=_auth(),
        )

    assert exc.value.status_code == 400
    assert exc.value.detail == "Conversation is too long"
    token_count_mock.assert_awaited_once()


@pytest.mark.asyncio
async def test_add_context_ids_agentic_skips_token_budget(monkeypatch) -> None:
    """Agentic preloads nothing, so a batch that blows the budget several times
    over still attaches in full and never costs a token count."""

    conversations = [_conv("conv-1"), _conv("conv-2"), _conv("conv-3")]
    token_counts_mock = AsyncMock(return_value={})
    fake_chat_service = _patch_batch_deps(
        monkeypatch,
        chat_mode="agentic",
        conversations=conversations,
        token_counts={},
    )
    monkeypatch.setattr(chat_api, "get_conversation_token_counts_bulk", token_counts_mock)
    get_chat_context_mock = AsyncMock()
    monkeypatch.setattr(chat_api, "get_chat_context", get_chat_context_mock)

    response = await chat_api.add_chat_context(
        chat_id="chat-1",
        body=chat_api.ChatAddContextSchema(
            conversation_ids=["conv-1", "conv-2", "conv-3"],
            project_id="project-1",
        ),
        auth=_auth(),
    )

    assert [item.conversation_id for item in (response.added or [])] == [
        "conv-1",
        "conv-2",
        "conv-3",
    ]
    assert response.skipped == []
    assert response.context_limit_reached is False
    token_counts_mock.assert_not_awaited()
    get_chat_context_mock.assert_not_awaited()
    assert fake_chat_service.attach_calls == [("chat-1", ["conv-1", "conv-2", "conv-3"])]


@pytest.mark.asyncio
async def test_add_context_ids_deep_dive_accumulates_budget(monkeypatch) -> None:
    """The whole point of batching: the budget accumulates across the batch, so
    the run stops partway and says why instead of letting everything through."""

    conversations = [_conv("conv-1"), _conv("conv-2"), _conv("conv-3")]
    half = chat_api.MAX_CHAT_CONTEXT_LENGTH // 2
    fake_chat_service = _patch_batch_deps(
        monkeypatch,
        chat_mode="deep_dive",
        conversations=conversations,
        # Each is well under the cap on its own; together they are not.
        token_counts={"conv-1": half, "conv-2": half, "conv-3": half},
    )

    response = await chat_api.add_chat_context(
        chat_id="chat-1",
        body=chat_api.ChatAddContextSchema(
            conversation_ids=["conv-1", "conv-2", "conv-3"],
            project_id="project-1",
        ),
        auth=_auth(),
    )

    assert [item.conversation_id for item in (response.added or [])] == ["conv-1", "conv-2"]
    assert [(item.conversation_id, item.reason) for item in (response.skipped or [])] == [
        ("conv-3", "context_limit_reached")
    ]
    assert response.context_limit_reached is True
    assert response.total_processed == 3
    # Only what fit is actually attached, in one bulk write.
    assert fake_chat_service.attach_calls == [("chat-1", ["conv-1", "conv-2"])]


@pytest.mark.asyncio
async def test_add_context_ids_reports_conversations_outside_the_project(monkeypatch) -> None:
    """The lookup is scoped to the chat's project, so a foreign id comes back as
    not_found rather than being attached or silently dropped."""

    conversations = [_conv("conv-1")]
    fake_chat_service = _patch_batch_deps(
        monkeypatch,
        chat_mode="deep_dive",
        conversations=conversations,
        token_counts={"conv-1": 10},
    )

    response = await chat_api.add_chat_context(
        chat_id="chat-1",
        body=chat_api.ChatAddContextSchema(
            conversation_ids=["conv-1", "conv-from-another-project"],
            project_id="project-1",
        ),
        auth=_auth(),
    )

    assert [item.conversation_id for item in (response.added or [])] == ["conv-1"]
    assert [(item.conversation_id, item.reason) for item in (response.skipped or [])] == [
        ("conv-from-another-project", "not_found")
    ]
    assert response.total_processed == 2
    assert fake_chat_service.attach_calls == [("chat-1", ["conv-1"])]


@pytest.mark.asyncio
async def test_add_context_ids_mode_none_is_gated_like_deep_dive(monkeypatch) -> None:
    """Same as the single-conversation case: a chat that has not picked a mode
    yet keeps the budget, so an over-long batch is trimmed, not waved through."""

    conversations = [_conv("conv-1"), _conv("conv-2")]
    fake_chat_service = _patch_batch_deps(
        monkeypatch,
        chat_mode=None,
        conversations=conversations,
        token_counts={
            "conv-1": chat_api.MAX_CHAT_CONTEXT_LENGTH,
            "conv-2": chat_api.MAX_CHAT_CONTEXT_LENGTH,
        },
    )

    response = await chat_api.add_chat_context(
        chat_id="chat-1",
        body=chat_api.ChatAddContextSchema(
            conversation_ids=["conv-1", "conv-2"],
            project_id="project-1",
        ),
        auth=_auth(),
    )

    assert [item.conversation_id for item in (response.added or [])] == ["conv-1"]
    assert [(item.conversation_id, item.reason) for item in (response.skipped or [])] == [
        ("conv-2", "context_limit_reached")
    ]
    assert fake_chat_service.attach_calls == [("chat-1", ["conv-1"])]


@pytest.mark.asyncio
async def test_add_context_rejects_more_than_one_option(monkeypatch) -> None:
    """Exactly one of the three entry points, so a caller can never half-mean
    two different things."""

    async def _fake_raise_if_chat_not_found_or_not_authorized(*_args, **_kwargs):  # noqa: ANN002, ANN003
        return _chat_row("deep_dive")

    monkeypatch.setattr(
        chat_api,
        "raise_if_chat_not_found_or_not_authorized",
        _fake_raise_if_chat_not_found_or_not_authorized,
    )

    with pytest.raises(HTTPException) as exc:
        await chat_api.add_chat_context(
            chat_id="chat-1",
            body=chat_api.ChatAddContextSchema(
                conversation_id="conv-1",
                conversation_ids=["conv-2"],
                project_id="project-1",
            ),
            auth=_auth(),
        )
    assert exc.value.status_code == 400

    with pytest.raises(HTTPException) as exc:
        await chat_api.add_chat_context(
            chat_id="chat-1",
            body=chat_api.ChatAddContextSchema(project_id="project-1"),
            auth=_auth(),
        )
    assert exc.value.status_code == 400
