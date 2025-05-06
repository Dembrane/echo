import logging
from typing import Any, Dict

from dembrane.directus import directus

logger = logging.getLogger("test_common")


def create_project(name: str, language: str, additional_data: Dict[str, Any] = None):
    """
    Creates a new project in Directus with the specified name and language.
    
    If provided, additional_data is merged into the project fields. The project is created with conversation allowed by default.
    
    Args:
        name: The name of the project.
        language: The language associated with the project.
        additional_data: Optional dictionary of extra fields to include in the project.
    
    Returns:
        The created project data as returned by Directus.
    """
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
    """
    Deletes a project from Directus by its project ID.
    
    Args:
        project_id: The unique identifier of the project to delete.
    """
    directus.delete_item("project", project_id)


def create_conversation(project_id: str, name: str, additional_data: Dict[str, Any] = None):
    """
    Creates a new conversation linked to a specified project.
    
    Args:
        project_id: The ID of the project to associate with the conversation.
        name: The name of the conversation.
        additional_data: Optional dictionary of extra fields to include in the conversation.
    
    Returns:
        The created conversation data as returned by the backend.
    """
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
    """
    Deletes a conversation item from the Directus backend by its ID.
    
    Args:
    	conversation_id: The unique identifier of the conversation to delete.
    """
    directus.delete_item("conversation", conversation_id)


def create_conversation_chunk(
    conversation_id: str, transcript: str, additional_data: Dict[str, Any] = None
):
    """
    Creates a conversation chunk linked to a conversation with the given transcript.
    
    Args:
        conversation_id: The ID of the conversation to associate with the chunk.
        transcript: The transcript text for the conversation chunk.
        additional_data: Optional dictionary of extra fields to include in the chunk.
    
    Returns:
        The created conversation chunk data as returned by the backend.
    """
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
