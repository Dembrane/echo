from unittest.mock import Mock, patch

import pytest

from dembrane.service.chat import ChatService, ChatServiceException


def test_set_chat_mode_accepts_agentic() -> None:
    service = ChatService()

    with patch("dembrane.service.chat.directus_client_context") as mock_context:
        mock_client = Mock()
        mock_client.update_item.return_value = {"data": {"id": "chat-1", "chat_mode": "agentic"}}
        mock_context.return_value.__enter__.return_value = mock_client

        updated = service.set_chat_mode("chat-1", "agentic")

    assert updated["chat_mode"] == "agentic"
    mock_client.update_item.assert_called_once_with(
        "project_chat",
        "chat-1",
        {"chat_mode": "agentic"},
    )


def test_set_chat_mode_rejects_invalid_mode() -> None:
    service = ChatService()

    with pytest.raises(ChatServiceException):
        service.set_chat_mode("chat-1", "unknown-mode")
