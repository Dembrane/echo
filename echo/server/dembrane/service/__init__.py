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
project_service = ProjectService()
conversation_service = ConversationService(
    file_service=file_service,
    project_service=project_service,
)

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
    "project": {
        "ProjectNotFoundException": ProjectNotFoundException,
        "ProjectServiceException": ProjectServiceException,
    },
}
