"""The add-context token budget is correct for deep_dive (which preloads full
transcripts into the prompt) but wrong for agentic (which preloads nothing and
only uses the attached rows as a focus hint). Agentic must bypass the
MAX_CHAT_CONTEXT_LENGTH gate; deep_dive must keep it exactly as before."""

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


def _chat_row(chat_mode: str) -> dict:
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
