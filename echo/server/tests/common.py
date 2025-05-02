import logging
from typing import Any, Dict

from dembrane.directus import directus

logger = logging.getLogger("test_common")


def create_project(name: str, language: str, additional_data: Dict[str, Any] = None):
    return directus.create_item(
        "project",
        {
            "name": name,
            "language": language,
            "is_conversation_allowed": True,
            **(additional_data or {}),
        },
    )["data"]


def delete_project(project_id: str):
    directus.delete_item("project", project_id)


def create_conversation(project_id: str, name: str, additional_data: Dict[str, Any] = None):
    return directus.create_item(
        "conversation",
        {
            "name": name,
            "project_id": project_id,
            "is_conversation_allowed": True,
            **(additional_data or {}),
        },
    )["data"]


def delete_conversation(conversation_id: str):
    directus.delete_item("conversation", conversation_id)


def create_conversation_chunk(
    conversation_id: str, transcript: str, additional_data: Dict[str, Any] = None
):
    logger.debug(
        f"Creating conversation chunk with data: {additional_data}, transcript: {transcript}, conversation_id: {conversation_id}"
    )
    return directus.create_item(
        "conversation_chunk",
        {
            "transcript": transcript,
            "participant_name": "test_participant",
            "conversation_id": conversation_id,
            **(additional_data or {}),
        },
    )["data"]


def delete_conversation_chunk(conversation_chunk_id: str):
    directus.delete_item("conversation_chunk", conversation_chunk_id)
