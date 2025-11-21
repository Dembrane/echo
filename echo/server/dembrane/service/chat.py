from typing import Any, List, Iterable, Optional, ContextManager
from logging import getLogger

from dembrane.directus import DirectusClient, DirectusBadRequest, directus, directus_client_context

logger = getLogger("dembrane.service.chat")


class ChatServiceException(Exception):
    pass


class ChatNotFoundException(ChatServiceException):
    pass


class ChatMessageNotFoundException(ChatServiceException):
    pass


class ChatService:
    def __init__(self, directus_client: Optional[DirectusClient] = None) -> None:
        self._directus_client = directus_client or directus

    def _client_context(
        self, override_client: Optional[DirectusClient] = None
    ) -> ContextManager[DirectusClient]:
        return directus_client_context(override_client or self._directus_client)

    def get_by_id_or_raise(
        self,
        chat_id: str,
        with_used_conversations: bool = False,
    ) -> dict:
        fields = [
            "id",
            "name",
            "auto_select",
            "project_id.id",
            "project_id.directus_user_id",
        ]

        deep: dict[str, Any] = {}

        if with_used_conversations:
            fields.extend(
                [
                    "used_conversations.id",
                    "used_conversations.conversation_id.id",
                    "used_conversations.conversation_id.participant_name",
                ]
            )
            deep["used_conversations"] = {"_sort": "id"}

        try:
            with self._client_context() as client:
                chat_list: Optional[List[dict]] = client.get_items(
                    "project_chat",
                    {
                        "query": {
                            "filter": {"id": {"_eq": chat_id}},
                            "fields": fields,
                            "deep": deep,
                            "limit": 1,
                        }
                    },
                )
        except DirectusBadRequest as e:
            logger.error("Failed to fetch chat %s from Directus: %s", chat_id, e)
            raise ChatServiceException() from e

        if not chat_list:
            raise ChatNotFoundException(f"Chat {chat_id} not found")

        return chat_list[0]

    def list_messages(
        self,
        chat_id: str,
        *,
        include_relationships: bool = True,
        order: str = "asc",
    ) -> List[dict]:
        fields = [
            "id",
            "project_chat_id",
            "message_from",
            "text",
            "tokens_count",
            "template_key",
            "date_created",
        ]

        deep: dict[str, Any] = {}

        if include_relationships:
            fields.extend(
                [
                    "used_conversations.id",
                    "used_conversations.conversation_id.id",
                    "used_conversations.conversation_id.participant_name",
                    "used_conversations.conversation_id.summary",
                    "used_conversations.conversation_id.duration",
                    "added_conversations.id",
                    "added_conversations.conversation_id.id",
                    "added_conversations.conversation_id.participant_name",
                ]
            )
            deep = {
                "used_conversations": {"_sort": "id"},
                "added_conversations": {"_sort": "id"},
            }

        sort_value = "date_created" if order.lower() != "desc" else "-date_created"

        try:
            with self._client_context() as client:
                messages: Optional[List[dict]] = client.get_items(
                    "project_chat_message",
                    {
                        "query": {
                            "filter": {"project_chat_id": {"_eq": chat_id}},
                            "fields": fields,
                            "deep": deep,
                            "limit": 1000,
                            "sort": sort_value,
                        }
                    },
                )
        except DirectusBadRequest as e:
            logger.error("Failed to list messages for chat %s: %s", chat_id, e)
            raise ChatServiceException() from e

        return messages or []

    def set_auto_select(self, chat_id: str, value: bool) -> dict:
        try:
            with self._client_context() as client:
                return client.update_item(
                    "project_chat",
                    chat_id,
                    {"auto_select": bool(value)},
                )["data"]
        except DirectusBadRequest as e:
            logger.error("Failed to update auto_select for chat %s: %s", chat_id, e)
            raise ChatServiceException() from e

    def set_chat_name(self, chat_id: str, name: Optional[str]) -> dict:
        try:
            with self._client_context() as client:
                return client.update_item(
                    "project_chat",
                    chat_id,
                    {"name": name},
                )["data"]
        except DirectusBadRequest as e:
            logger.error("Failed to update chat name for %s: %s", chat_id, e)
            raise ChatServiceException() from e

    def attach_conversations(self, chat_id: str, conversation_ids: Iterable[str]) -> None:
        payload_list = [
            {"conversation_id": conversation_id} for conversation_id in conversation_ids
        ]

        if not payload_list:
            return

        try:
            with self._client_context() as client:
                client.update_item(
                    "project_chat",
                    chat_id,
                    {"used_conversations": {"create": payload_list}},
                )
        except DirectusBadRequest as e:
            logger.error(
                "Failed to attach conversations %s to chat %s: %s",
                list(conversation_ids),
                chat_id,
                e,
            )
            raise ChatServiceException() from e

    def detach_conversation(self, chat_id: str, conversation_id: str) -> None:
        try:
            with self._client_context() as client:
                links: Optional[List[dict]] = client.get_items(
                    "project_chat_conversation",
                    {
                        "query": {
                            "filter": {
                                "project_chat_id": {"_eq": chat_id},
                                "conversation_id": {"_eq": conversation_id},
                            },
                            "fields": ["id"],
                            "limit": 20,
                        }
                    },
                )

                for link in links or []:
                    link_id = link.get("id")
                    if link_id:
                        client.delete_item("project_chat_conversation", link_id)
        except DirectusBadRequest as e:
            logger.error(
                "Failed to detach conversation %s from chat %s: %s",
                conversation_id,
                chat_id,
                e,
            )
            raise ChatServiceException() from e

    def create_message(
        self,
        chat_id: str,
        message_from: str,
        text: str,
        *,
        message_id: Optional[str] = None,
        template_key: Optional[str] = None,
        used_conversation_ids: Optional[Iterable[str]] = None,
        added_conversation_ids: Optional[Iterable[str]] = None,
        extra_fields: Optional[dict[str, Any]] = None,
    ) -> dict:
        payload: dict[str, Any] = {
            "project_chat_id": chat_id,
            "message_from": message_from,
            "text": text,
        }

        if message_id is not None:
            payload["id"] = message_id

        if template_key is not None:
            payload["template_key"] = template_key

        if extra_fields:
            payload.update(extra_fields)

        used_ids = list(used_conversation_ids or [])
        if used_ids:
            payload.setdefault("used_conversations", {})["create"] = [
                {"conversation_id": conversation_id} for conversation_id in used_ids
            ]

        added_ids = list(added_conversation_ids or [])
        if added_ids:
            payload.setdefault("added_conversations", {})["create"] = [
                {"conversation_id": conversation_id} for conversation_id in added_ids
            ]

        try:
            with self._client_context() as client:
                message = client.create_item(
                    "project_chat_message",
                    item_data=payload,
                )["data"]
        except DirectusBadRequest as e:
            logger.error("Failed to create message in chat %s: %s", chat_id, e)
            raise ChatServiceException() from e

        return message

    def update_message(self, message_id: str, update_data: dict[str, Any]) -> dict:
        try:
            with self._client_context() as client:
                message = client.update_item(
                    "project_chat_message",
                    message_id,
                    update_data,
                )["data"]
        except DirectusBadRequest as e:
            logger.error("Failed to update message %s: %s", message_id, e)
            raise ChatServiceException() from e

        return message

    def delete_message(self, message_id: str) -> None:
        try:
            with self._client_context() as client:
                client.delete_item("project_chat_message", message_id)
        except DirectusBadRequest as e:
            logger.error("Failed to delete message %s: %s", message_id, e)
            raise ChatServiceException() from e
