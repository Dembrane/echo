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


def test_create_shallow_clone():
    project = project_service.create(
        name="Test Project",
        language="en",
        is_conversation_allowed=True,
        default_conversation_title="Test Conversation",
        default_conversation_description="Test Conversation Description",
        default_conversation_finish_text="Test Conversation Finish Text",
        default_conversation_ask_for_participant_name=True,
        default_conversation_tutorial_slug="test-tutorial-slug",
        default_conversation_transcript_prompt="Test Conversation Transcript Prompt",
        conversation_ask_for_participant_name_label="Test Conversation Ask for Participant Name Label",
        image_generation_model="Test Image Generation Model",
        is_enhanced_audio_processing_enabled=True,
        is_get_reply_enabled=True,
        is_project_notification_subscription_allowed=True,
        context="Test Context",
    )

    tags = project_service.create_tags_and_link(project["id"], ["tag1", "tag2"])

    new_project_id = project_service.create_shallow_clone(project["id"], with_tags=True)

    new_project = project_service.get_by_id_or_raise(new_project_id, with_tags=True)

    assert new_project_id is not None

    assert project["name"] == new_project["name"]
    assert project["language"] == new_project["language"]
    assert project["is_conversation_allowed"] == new_project["is_conversation_allowed"]
    assert project["default_conversation_title"] == new_project["default_conversation_title"]
    assert (
        project["default_conversation_description"]
        == new_project["default_conversation_description"]
    )
    assert (
        project["default_conversation_finish_text"]
        == new_project["default_conversation_finish_text"]
    )
    assert (
        project["default_conversation_ask_for_participant_name"]
        == new_project["default_conversation_ask_for_participant_name"]
    )
    assert (
        project["default_conversation_tutorial_slug"]
        == new_project["default_conversation_tutorial_slug"]
    )
    assert (
        project["default_conversation_transcript_prompt"]
        == new_project["default_conversation_transcript_prompt"]
    )
    assert (
        project["conversation_ask_for_participant_name_label"]
        == new_project["conversation_ask_for_participant_name_label"]
    )
    assert project["image_generation_model"] == new_project["image_generation_model"]
    assert (
        project["is_enhanced_audio_processing_enabled"]
        == new_project["is_enhanced_audio_processing_enabled"]
    )
    assert project["is_get_reply_enabled"] == new_project["is_get_reply_enabled"]
    assert (
        project["is_project_notification_subscription_allowed"]
        == new_project["is_project_notification_subscription_allowed"]
    )
    assert project["context"] == new_project["context"]

    tags_str = []
    for tags in new_project["tags"]:
        tags_str.append(tags["text"])

    assert len(tags_str) == 2
    assert tags_str[0] == "tag1"
    assert tags_str[1] == "tag2"

    project_service.delete(project["id"])
    project_service.delete(new_project_id)
