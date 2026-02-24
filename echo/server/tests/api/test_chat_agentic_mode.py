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


@pytest.mark.asyncio
async def test_initialize_chat_mode_supports_agentic(monkeypatch) -> None:
    async def _fake_raise_if_chat_not_found_or_not_authorized(*_args, **_kwargs):  # noqa: ANN002, ANN003
        return {"chat_mode": None}

    async def _fake_run_in_thread_pool(func, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003
        return func(*args, **kwargs)

    class _FakeChatService:
        def set_chat_mode(self, chat_id: str, mode: str) -> dict[str, str]:
            return {"id": chat_id, "chat_mode": mode}

    monkeypatch.setattr(
        chat_api,
        "raise_if_chat_not_found_or_not_authorized",
        _fake_raise_if_chat_not_found_or_not_authorized,
    )
    monkeypatch.setattr(chat_api, "run_in_thread_pool", _fake_run_in_thread_pool)
    monkeypatch.setattr(chat_api, "chat_service", _FakeChatService())

    response = await chat_api.initialize_chat_mode(
        chat_id="chat-1",
        body=chat_api.InitializeChatModeSchema(mode="agentic", project_id="project-1"),
        auth=_auth(),
    )

    assert response.chat_mode == "agentic"
    assert response.conversations_added == 0
    assert response.conversations_summarized == 0


@pytest.mark.asyncio
async def test_post_chat_rejects_agentic_mode(monkeypatch) -> None:
    async def _fake_raise_if_chat_not_found_or_not_authorized(*_args, **_kwargs):  # noqa: ANN002, ANN003
        return {"chat_mode": "agentic"}

    monkeypatch.setattr(
        chat_api,
        "raise_if_chat_not_found_or_not_authorized",
        _fake_raise_if_chat_not_found_or_not_authorized,
    )

    with pytest.raises(HTTPException) as exc:
        await chat_api.post_chat(
            chat_id="chat-1",
            body=chat_api.ChatBodySchema(messages=[{"role": "user", "content": "hello"}]),
            auth=_auth(),
        )

    assert exc.value.status_code == 400
