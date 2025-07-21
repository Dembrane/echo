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

# Import service classes
from .file import get_file_service
from .event import EventService
from .project import ProjectService
from .conversation import ConversationService

# Create service instances without circular dependencies
file_service = get_file_service()
event_service = EventService()
project_service = ProjectService()
conversation_service = ConversationService(
    file_service=file_service,
    event_service=event_service,
    project_service=project_service,
)
