"""
Service layer for Dembrane application.

This module provides access to all service classes and default service instances.
Services handle business logic and interact with external resources like databases,
file storage, etc.

Usage:
    # Import service instances
    from dembrane.service import file_service, conversation_service, project_service

    # Use the services
    file_url = file_service.save(file, "my-file-key", public=True)
    conversation = conversation_service.create(project_id, "John Doe")
    project = project_service.get_by_id_or_raise(project_id)
"""

from typing import Optional

from dembrane.directus import DirectusClient, directus

from .chat import (
    ChatService,
    ChatServiceException,
    ChatNotFoundException,
    ChatMessageNotFoundException,
)
from .file import FileServiceException, get_file_service
from .project import ProjectService, ProjectServiceException, ProjectNotFoundException
from .conversation import (
    ConversationService,
    ConversationServiceException,
    ConversationNotFoundException,
    ConversationChunkNotFoundException,
    ConversationNotOpenForParticipationException,
)

file_service = get_file_service()


def build_project_service(directus_client: Optional[DirectusClient] = None) -> ProjectService:
    return ProjectService(directus_client=directus_client or directus)


def build_chat_service(directus_client: Optional[DirectusClient] = None) -> ChatService:
    return ChatService(directus_client=directus_client or directus)


def build_conversation_service(
    directus_client: Optional[DirectusClient] = None,
) -> ConversationService:
    client = directus_client or directus
    return ConversationService(
        file_service=file_service,
        project_service=build_project_service(client),
        directus_client=client,
    )


project_service = build_project_service()
conversation_service = build_conversation_service()
chat_service = build_chat_service()

exceptions = {
    "file": {
        "FileServiceException": FileServiceException,
    },
    "conversation": {
        "ConversationChunkNotFoundException": ConversationChunkNotFoundException,
        "ConversationNotFoundException": ConversationNotFoundException,
        "ConversationNotOpenForParticipationException": ConversationNotOpenForParticipationException,
        "ConversationServiceException": ConversationServiceException,
    },
    "chat": {
        "ChatServiceException": ChatServiceException,
        "ChatNotFoundException": ChatNotFoundException,
        "ChatMessageNotFoundException": ChatMessageNotFoundException,
    },
    "project": {
        "ProjectNotFoundException": ProjectNotFoundException,
        "ProjectServiceException": ProjectServiceException,
    },
}
