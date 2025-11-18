import logging
from typing import Any, Dict

from dembrane.directus import directus
from dembrane.utils import get_utc_timestamp

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
    logger.debug(f"Deleting project: {project_id}")
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
    logger.debug(f"Deleting conversation: {conversation_id}")
    directus.delete_item("conversation", conversation_id)


def create_conversation_chunk(
    conversation_id: str, transcript: str, additional_data: Dict[str, Any] = None
):
    logger.debug(
        f"Creating conversation chunk with data: {additional_data}, transcript: {transcript}, conversation_id: {conversation_id}"
    )
    payload: Dict[str, Any] = {
        "transcript": transcript,
        "participant_name": "test_participant",
        "conversation_id": conversation_id,
        "timestamp": get_utc_timestamp().isoformat(),
    }
    if additional_data:
        payload.update(additional_data)

    return directus.create_item("conversation_chunk", payload)["data"]


def delete_conversation_chunk(conversation_chunk_id: str):
    logger.debug(f"Deleting conversation chunk: {conversation_chunk_id}")
    directus.delete_item("conversation_chunk", conversation_chunk_id)


def create_conversation_segment(
    conversation_id: str, lightrag_flag: bool, additional_data: Dict[str, Any] = None
):
    logger.debug(
        f"Creating conversation segment with data: {additional_data}, conversation_id: {conversation_id}, lightrag_flag: {lightrag_flag}"
    )
    return directus.create_item(
        "conversation_segment",
        {
            "conversation_id": conversation_id,
            "lightrag_flag": lightrag_flag,
            **(additional_data or {}),
        },
    )["data"]


def delete_conversation_segment(conversation_segment_id: str):
    directus.delete_item("conversation_segment", conversation_segment_id)
