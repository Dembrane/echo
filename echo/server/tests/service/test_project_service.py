import logging
from unittest.mock import Mock, patch

import pytest

from dembrane.service import project_service
from dembrane.service.project import ProjectNotFoundException

logger = logging.getLogger(__name__)


def test_create_project():
    project = project_service.create(
        name="Test Project",
        language="en",
        is_conversation_allowed=True,
    )

    assert project is not None
    assert project.get("name") == "Test Project"
    assert project.get("language") == "en"
    assert project.get("is_conversation_allowed") is True

    project_service.delete(project["id"])


def test_create_and_link_tags():
    project = project_service.create(
        name="Test Project",
        language="en",
        is_conversation_allowed=True,
    )

    tags = project_service.create_tags_and_link(project["id"], ["tag1", "tag2"])

    assert len(tags) == 2

    project = project_service.get_by_id_or_raise(project["id"], with_tags=True)

    assert len(project.get("tags", [])) == 2
    assert project["tags"][0]["text"] == "tag1"
    assert project["tags"][1]["text"] == "tag2"
    assert project["tags"][0]["id"] is not None
    assert project["tags"][1]["id"] is not None
    assert project["tags"][0]["created_at"] is not None
    assert project["tags"][1]["created_at"] is not None

    project_service.delete(project["id"])


def test_get_by_id_or_raise():
    project = project_service.create(
        name="Test Project",
        language="en",
        is_conversation_allowed=True,
    )

    assert project_service.get_by_id_or_raise(project["id"]) is not None

    project_service.delete(project["id"])


def test_get_by_id_not_found():
    with pytest.raises(ProjectNotFoundException):
        project_service.get_by_id_or_raise("not-found")


def test_get_by_id_empty_result():
    """Test exception handling when no project found."""
    with patch("dembrane.service.project.directus_client_context") as mock_context:
        mock_client = Mock()
        mock_client.get_items.return_value = []
        mock_context().__enter__.return_value = mock_client

        with pytest.raises(ProjectNotFoundException):
            project_service.get_by_id_or_raise("test-id")


def test_delete_project():
    project = project_service.create(
        name="Test Project",
        language="en",
        is_conversation_allowed=True,
    )

    project_service.delete(project["id"])

    with pytest.raises(ProjectNotFoundException):
        project_service.get_by_id_or_raise(project["id"])
