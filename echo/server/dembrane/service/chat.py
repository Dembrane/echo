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
            "chat_mode",
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

    def set_chat_mode(self, chat_id: str, mode: str) -> dict:
        """Set the chat mode (overview, deep_dive, or agentic)."""
        if mode not in ("overview", "deep_dive", "agentic"):
            raise ChatServiceException(f"Invalid chat mode: {mode}")
        try:
            with self._client_context() as client:
                return client.update_item(
                    "project_chat",
                    chat_id,
                    {"chat_mode": mode},
                )["data"]
        except DirectusBadRequest as e:
            logger.error("Failed to update chat_mode for chat %s: %s", chat_id, e)
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
        logger.debug("Attaching conversations %s to chat %s", conversation_ids, chat_id)
        payload_list = [
            {"conversation_id": conversation_id, "project_chat_id": chat_id}
            for conversation_id in conversation_ids
        ]

        if not payload_list:
            logger.warning("No conversations to attach to chat %s", chat_id)
            return

        try:
            with self._client_context() as client:
                # create items directly in the junction table instead of using
                # nested create through parent update, which has validation issues
                client.bulk_insert("project_chat_conversation", payload_list)
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

    def get_last_assistant_message(self, chat_id: str) -> Optional[str]:
        """Get the most recent assistant response text for a chat."""
        try:
            with self._client_context() as client:
                messages: Optional[List[dict]] = client.get_items(
                    "project_chat_message",
                    {
                        "query": {
                            "filter": {
                                "project_chat_id": {"_eq": chat_id},
                                "message_from": {"_eq": "assistant"},
                            },
                            "fields": ["text"],
                            "sort": "-date_created",
                            "limit": 1,
                        }
                    },
                )
                if messages and len(messages) > 0:
                    msg = messages[0]
                    # Handle case where msg might not be a dict
                    if isinstance(msg, dict):
                        return msg.get("text")
                    elif isinstance(msg, str):
                        return msg
                    logger.debug(f"Unexpected message type: {type(msg)}")
                return None
        except DirectusBadRequest as e:
            logger.error("Failed to get last assistant message for chat %s: %s", chat_id, e)
            return None

    def list_recent_user_queries(
        self,
        project_id: str,
        current_chat_id: Optional[str] = None,
        limit: int = 5,
    ) -> List[str]:
        """
        Get recent user queries from chats in the project.
        Prioritizes queries from current_chat_id first, then other chats.
        """
        queries: List[str] = []

        try:
            with self._client_context() as client:
                # First, get queries from current chat if provided
                if current_chat_id:
                    current_messages: Optional[List[dict]] = client.get_items(
                        "project_chat_message",
                        {
                            "query": {
                                "filter": {
                                    "project_chat_id": {"_eq": current_chat_id},
                                    "message_from": {"_eq": "user"},
                                },
                                "fields": ["text"],
                                "sort": "-date_created",
                                "limit": limit,
                            }
                        },
                    )
                    for msg in current_messages or []:
                        # Handle case where msg might not be a dict
                        if not isinstance(msg, dict):
                            logger.debug(f"Skipping non-dict message: {type(msg)}")
                            continue
                        text = (msg.get("text") or "").strip()
                        if text and text not in queries:
                            queries.append(text)

                # If we need more, get from other project chats
                if len(queries) < limit:
                    # Get all chats for the project
                    chats: Optional[List[dict]] = client.get_items(
                        "project_chat",
                        {
                            "query": {
                                "filter": {"project_id": {"_eq": project_id}},
                                "fields": ["id"],
                                "sort": "-date_created",
                                "limit": 10,
                            }
                        },
                    )

                    other_chat_ids = []
                    for c in chats or []:
                        if not isinstance(c, dict):
                            continue
                        chat_id = c.get("id")
                        if chat_id and chat_id != current_chat_id:
                            other_chat_ids.append(chat_id)

                    if other_chat_ids:
                        other_messages: Optional[List[dict]] = client.get_items(
                            "project_chat_message",
                            {
                                "query": {
                                    "filter": {
                                        "project_chat_id": {"_in": other_chat_ids},
                                        "message_from": {"_eq": "user"},
                                    },
                                    "fields": ["text"],
                                    "sort": "-date_created",
                                    "limit": limit - len(queries),
                                }
                            },
                        )
                        for msg in other_messages or []:
                            # Handle case where msg might not be a dict
                            if not isinstance(msg, dict):
                                logger.debug(f"Skipping non-dict message: {type(msg)}")
                                continue
                            text = (msg.get("text") or "").strip()
                            if text and text not in queries:
                                queries.append(text)
                                if len(queries) >= limit:
                                    break

        except DirectusBadRequest as e:
            logger.error("Failed to list recent user queries for project %s: %s", project_id, e)

        return queries[:limit]

    def get_locked_conversations_with_summaries(
        self,
        chat_id: str,
    ) -> List[dict]:
        """
        Get locked conversations for a chat with their summaries.
        Returns list of dicts with id, name, and summary fields.
        """
        try:
            with self._client_context() as client:
                # Fetch locked conversations with nested fields using dot notation
                # This ensures Directus returns the full nested object, not just ID
                links: Optional[List[dict]] = client.get_items(
                    "project_chat_conversation",
                    {
                        "query": {
                            "filter": {
                                "project_chat_id": {"_eq": chat_id},
                                "locked": {"_eq": True},
                            },
                            "fields": [
                                "id",
                                "conversation_id.id",
                                "conversation_id.participant_name",
                                "conversation_id.summary",
                            ],
                            "limit": 50,
                        }
                    },
                )

                logger.debug(f"Locked conversation links for chat {chat_id}: {links}")

                if not links:
                    return []

                result = []
                for link in links:
                    if not isinstance(link, dict):
                        logger.debug(f"Skipping non-dict link: {type(link)}")
                        continue

                    conv = link.get("conversation_id")
                    if not isinstance(conv, dict):
                        logger.debug(f"Skipping link with non-dict conversation_id: {type(conv)}")
                        continue

                    result.append(
                        {
                            "id": conv.get("id"),
                            "name": conv.get("participant_name", "Unknown"),
                            "summary": conv.get("summary"),
                        }
                    )

                logger.debug(
                    f"Returning {len(result)} conversations with summaries for chat {chat_id}"
                )
                return result

        except DirectusBadRequest as e:
            logger.error("Failed to get locked conversations for chat %s: %s", chat_id, e)
            return []
