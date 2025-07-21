import logging
from io import BytesIO
from datetime import datetime, timedelta
from unittest.mock import Mock, patch

import pytest
from fastapi import UploadFile

from dembrane.service import project_service, conversation_service
from dembrane.directus import DirectusBadRequest
from dembrane.service.conversation import (
    ConversationService,
    ConversationNotFoundException,
    ConversationNotOpenForParticipationException,
)

logger = logging.getLogger(__name__)


@pytest.fixture
def project():
    project = project_service.create(
        name="Test Project for Conversation",
        language="en",
        is_conversation_allowed=True,
    )

    yield project

    project_service.delete(project["id"])


def test_create_conversation(project):
    conversation = conversation_service.create(
        project_id=project["id"],
        participant_name="Test Participant",
        participant_email="test@example.com",
        participant_user_agent="Test User Agent",
        source="TEST",
    )

    assert conversation is not None
    assert conversation.get("project_id") == project["id"]
    assert conversation.get("participant_name") == "Test Participant"
    assert conversation.get("participant_email") == "test@example.com"
    assert conversation.get("participant_user_agent") == "Test User Agent"
    assert conversation.get("source") == "TEST"

    conversation_service.delete(conversation["id"])


def test_create_conversation_with_tags(project):
    tags = project_service.create_tags_and_link(project.get("id"), ["tag1", "tag2"])

    tag_ids = [tag.get("id") for tag in tags]

    conversation = conversation_service.create(
        project_id=project["id"],
        participant_name="Test Participant",
        participant_email="test@example.com",
        participant_user_agent="Test User Agent",
        source="TEST",
        project_tag_id_list=tag_ids,
    )

    assert conversation is not None
    assert conversation.get("project_id") == project["id"]
    assert conversation.get("participant_name") == "Test Participant"
    assert conversation.get("participant_email") == "test@example.com"
    assert conversation.get("participant_user_agent") == "Test User Agent"
    assert conversation.get("source") == "TEST"

    fetched_conversation = conversation_service.get_by_id_or_raise(
        conversation["id"], with_tags=True
    )

    logger.info(fetched_conversation["tags"])

    assert len(fetched_conversation.get("tags", [])) == 2
    assert fetched_conversation["tags"][0]["project_tag_id"]["id"] == tag_ids[0]
    assert fetched_conversation["tags"][1]["project_tag_id"]["id"] == tag_ids[1]
    assert fetched_conversation["tags"][0]["project_tag_id"]["text"] == "tag1"
    assert fetched_conversation["tags"][1]["project_tag_id"]["text"] == "tag2"

    conversation_service.delete(conversation["id"])


def test_create_conversation_not_allowed():
    project = project_service.create(
        name="Test Project No Conversations",
        language="en",
        is_conversation_allowed=False,
    )

    with pytest.raises(ConversationNotOpenForParticipationException):
        conversation_service.create(
            project_id=project["id"],
            participant_name="Test Participant",
        )

    project_service.delete(project["id"])


def test_get_by_id_or_raise(project):
    conversation = conversation_service.create(
        project_id=project["id"],
        participant_name="Test Participant",
    )

    c = conversation_service.get_by_id_or_raise(conversation["id"])
    assert c is not None
    assert c["id"] == conversation["id"]
    assert c["participant_name"] == "Test Participant"

    conversation_service.delete(conversation["id"])


def test_get_by_id_or_raise_not_found():
    try:
        conversation_service.get_by_id_or_raise("non-existent-id")
    except Exception as e:
        assert isinstance(e, ConversationNotFoundException)


def test_update_conversation(project):
    conversation = conversation_service.create(
        project_id=project["id"],
        participant_name="Original Name",
        participant_email="original@example.com",
        source="ORIGINAL",
    )

    updated_conversation = conversation_service.update(
        conversation_id=conversation["id"],
        participant_name="Updated Name",
        participant_email="updated@example.com",
        summary="Test summary",
        source="UPDATED",
        is_finished=True,
    )

    assert updated_conversation is not None
    assert updated_conversation["participant_name"] == "Updated Name"
    assert updated_conversation["participant_email"] == "updated@example.com"
    assert updated_conversation["summary"] == "Test summary"
    assert updated_conversation["source"] == "UPDATED"
    assert updated_conversation["is_finished"] is True

    conversation_service.delete(conversation["id"])


def test_update_conversation_partial(project):
    conversation = conversation_service.create(
        project_id=project["id"],
        participant_name="Original Name",
        participant_email="original@example.com",
    )

    updated_conversation = conversation_service.update(
        conversation_id=conversation["id"],
        participant_name="Updated Name Only",
    )

    assert updated_conversation["participant_name"] == "Updated Name Only"
    assert updated_conversation["participant_email"] == "original@example.com"

    # Test updating only source field to cover line 159
    updated_with_source = conversation_service.update(
        conversation_id=conversation["id"],
        source="NEW_SOURCE",
    )
    assert updated_with_source["source"] == "NEW_SOURCE"

    conversation_service.delete(conversation["id"])


def test_update_conversation_not_found():
    with pytest.raises(ConversationNotFoundException):
        conversation_service.update(
            conversation_id="non-existent-id",
            participant_name="Updated Name",
        )


def test_delete_conversation(project):
    conversation = conversation_service.create(
        project_id=project["id"],
        participant_name="Test Participant",
    )

    conversation_service.delete(conversation["id"])

    with pytest.raises(ConversationNotFoundException):
        conversation_service.get_by_id_or_raise(conversation["id"])


def test_conversation_service_property_getters():
    """Test lazy initialization of service dependencies."""
    # Create a fresh service instance
    service = ConversationService()

    # Initially, all services should be None
    assert service._file_service is None
    assert service._event_service is None
    assert service._project_service is None

    # Access properties to trigger lazy initialization
    file_service = service.file_service
    event_service = service.event_service
    project_service = service.project_service

    # Verify services are initialized
    assert file_service is not None
    assert event_service is not None
    assert project_service is not None

    # Verify subsequent access returns same instances
    assert service.file_service is file_service
    assert service.event_service is event_service
    assert service.project_service is project_service


def test_get_by_id_directus_bad_request():
    """Test exception handling when Directus returns bad request."""
    with patch("dembrane.service.conversation.directus_client_context") as mock_context:
        mock_client = Mock()
        mock_client.get_items.side_effect = DirectusBadRequest("Bad request")
        mock_context().__enter__.return_value = mock_client

        with pytest.raises(ConversationNotFoundException):
            conversation_service.get_by_id_or_raise("test-id")


def test_get_by_id_empty_result():
    """Test exception handling when no conversation found."""
    with patch("dembrane.service.conversation.directus_client_context") as mock_context:
        mock_client = Mock()
        mock_client.get_items.return_value = []
        mock_context().__enter__.return_value = mock_client

        with pytest.raises(ConversationNotFoundException):
            conversation_service.get_by_id_or_raise("test-id")


def test_update_conversation_directus_bad_request():
    """Test exception handling when updating non-existent conversation."""
    with patch("dembrane.service.conversation.directus_client_context") as mock_context:
        mock_client = Mock()
        mock_client.update_item.side_effect = DirectusBadRequest("Not found")
        mock_context().__enter__.return_value = mock_client

        with pytest.raises(ConversationNotFoundException):
            conversation_service.update(conversation_id="non-existent-id", participant_name="Test")


def test_create_chunk_from_file(project):
    """Test creating conversation chunk from file upload."""
    conversation = conversation_service.create(
        project_id=project["id"],
        participant_name="Test Participant",
    )

    # Create a mock file upload
    file_content = b"Test audio content"
    file_obj = UploadFile(filename="test_audio.mp3", file=BytesIO(file_content))

    timestamp = datetime.now()

    with patch.object(conversation_service.file_service, "save") as mock_save:
        with patch.object(conversation_service.event_service, "publish") as mock_publish:
            mock_save.return_value = "https://s3.example.com/test_audio.mp3"

            chunk = conversation_service.create_chunk(
                conversation_id=conversation["id"],
                file_obj=file_obj,
                timestamp=timestamp,
                source="AUDIO",
            )

            assert chunk is not None
            assert chunk["conversation_id"] == conversation["id"]
            assert chunk["source"] == "AUDIO"
            assert chunk["path"] == "https://s3.example.com/test_audio.mp3"

            # Verify file was saved with correct parameters
            mock_save.assert_called_once()
            call_args = mock_save.call_args
            assert call_args[1]["key"].startswith(f"conversation/{conversation['id']}/chunks/")
            assert call_args[1]["key"].endswith("-test_audio.mp3")
            assert call_args[1]["public"] is False

            # Verify event was published
            mock_publish.assert_called_once()

    conversation_service.delete(conversation["id"])


def test_create_chunk_from_file_finished_conversation(project):
    """Test that chunks cannot be added to finished conversations."""
    conversation = conversation_service.create(
        project_id=project["id"],
        participant_name="Test Participant",
    )

    # Mark conversation as finished
    conversation_service.update(conversation_id=conversation["id"], is_finished=True)

    file_obj = UploadFile(filename="test.mp3", file=BytesIO(b"content"))

    with pytest.raises(ConversationNotOpenForParticipationException):
        conversation_service.create_chunk(
            conversation_id=conversation["id"],
            file_obj=file_obj,
            timestamp=datetime.now(),
            source="AUDIO",
        )

    conversation_service.delete(conversation["id"])


def test_create_chunk_from_text(project):
    """Test creating conversation chunk from text."""
    conversation = conversation_service.create(
        project_id=project["id"],
        participant_name="Test Participant",
    )

    timestamp = datetime.now()
    text_content = "This is a test transcript"

    with patch.object(conversation_service.event_service, "publish") as mock_publish:
        chunk = conversation_service.create_chunk(
            conversation_id=conversation["id"],
            transcript=text_content,
            timestamp=timestamp,
            source="TRANSCRIPT",
        )

        assert chunk is not None
        assert chunk["conversation_id"] == conversation["id"]
        assert chunk["transcript"] == text_content
        assert chunk["source"] == "TRANSCRIPT"
        # Verify timestamp format - Directus stores with millisecond precision and 'Z' suffix
        expected_timestamp = timestamp.isoformat()[:23] + "Z"
        if len(timestamp.isoformat()) <= 19:  # No microseconds
            expected_timestamp = timestamp.isoformat() + "Z"
        assert chunk["timestamp"] == expected_timestamp

        # Verify event was published
        mock_publish.assert_called_once()
        event = mock_publish.call_args[0][0]
        assert event.chunk_id == chunk["id"]
        assert event.conversation_id == conversation["id"]

    conversation_service.delete(conversation["id"])


def test_create_chunk_from_text_finished_conversation(project):
    """Test that text chunks cannot be added to finished conversations."""
    conversation = conversation_service.create(
        project_id=project["id"],
        participant_name="Test Participant",
    )

    # Mark conversation as finished
    conversation_service.update(conversation_id=conversation["id"], is_finished=True)

    with pytest.raises(ConversationNotOpenForParticipationException):
        conversation_service.create_chunk(
            conversation_id=conversation["id"],
            transcript="Test transcript",
            timestamp=datetime.now(),
            source="TRANSCRIPT",
        )

    conversation_service.delete(conversation["id"])


def test_get_by_id_with_chunks(project):
    """Test retrieving conversation with chunks sorted by timestamp."""
    conversation = conversation_service.create(
        project_id=project["id"],
        participant_name="Test Participant",
    )

    # Create multiple chunks
    for i in range(3):
        conversation_service.create_chunk(
            conversation_id=conversation["id"],
            transcript=f"Chunk {i}",
            timestamp=datetime.now(),
            source="TRANSCRIPT",
        )

    # Retrieve with chunks
    fetched = conversation_service.get_by_id_or_raise(conversation["id"], with_chunks=True)

    assert "chunks" in fetched
    assert len(fetched["chunks"]) == 3

    # Verify chunks are sorted by timestamp (descending)
    timestamps = [chunk["timestamp"] for chunk in fetched["chunks"]]
    assert timestamps == sorted(timestamps, reverse=True)

    conversation_service.delete(conversation["id"])


def test_delete_chunk(project):
    conversation = conversation_service.create(
        project_id=project["id"],
        participant_name="Test Participant",
    )

    chunk = conversation_service.create_chunk(
        conversation_id=conversation["id"],
        transcript="Test transcript",
        timestamp=datetime.now(),
        source="TRANSCRIPT",
    )

    chunk2 = conversation_service.create_chunk(
        conversation_id=conversation["id"],
        transcript="Test transcript 2",
        timestamp=datetime.now(),
        source="TRANSCRIPT",
    )

    chunks = conversation_service.get_by_id_or_raise(conversation["id"], with_chunks=True)["chunks"]

    assert len(chunks) == 2
    assert chunk["id"] in [c["id"] for c in chunks]
    assert chunk2["id"] in [c["id"] for c in chunks]

    conversation_service.delete_chunk(chunk["id"])

    chunks = conversation_service.get_by_id_or_raise(conversation["id"], with_chunks=True)["chunks"]

    assert len(chunks) == 1
    assert chunk["id"] not in [c["id"] for c in chunks]
    assert chunk2["id"] in [c["id"] for c in chunks]

    conversation_service.delete_chunk(chunk2["id"])

    chunks = conversation_service.get_by_id_or_raise(conversation["id"], with_chunks=True)["chunks"]

    conversation_service.delete(conversation["id"])


def test_chunk_timestamp_functionality(project):
    """Test comprehensive timestamp functionality for conversation chunks."""
    conversation = conversation_service.create(
        project_id=project["id"],
        participant_name="Test Participant",
    )

    # Create base timestamp
    base_time = datetime(2024, 1, 15, 10, 30, 45, 123456)

    # Create chunks with specific timestamps
    timestamps = [
        base_time,
        base_time + timedelta(minutes=5),
        base_time + timedelta(minutes=10),
        base_time - timedelta(minutes=5),
        base_time + timedelta(hours=1),
    ]

    created_chunks = []
    for i, ts in enumerate(timestamps):
        chunk = conversation_service.create_chunk(
            conversation_id=conversation["id"],
            transcript=f"Chunk {i} at {ts.isoformat()}",
            timestamp=ts,
            source="TRANSCRIPT",
        )
        created_chunks.append((chunk, ts))

        # Verify timestamp is stored correctly
        # Directus stores with millisecond precision and adds 'Z' suffix
        expected_timestamp = ts.isoformat()[:23] + "Z"  # Truncate to milliseconds
        assert chunk["timestamp"] == expected_timestamp

    # Retrieve conversation with chunks
    fetched = conversation_service.get_by_id_or_raise(conversation["id"], with_chunks=True)

    assert "chunks" in fetched
    assert len(fetched["chunks"]) == 5

    # Verify chunks are sorted by timestamp in descending order
    fetched_timestamps = [chunk["timestamp"] for chunk in fetched["chunks"]]
    # Convert our timestamps to the format Directus uses for comparison
    expected_order = sorted([ts.isoformat()[:23] + "Z" for ts in timestamps], reverse=True)
    assert fetched_timestamps == expected_order

    # Verify each chunk has the correct timestamp
    for chunk in fetched["chunks"]:
        # Find the original timestamp by matching chunk content
        for created_chunk, original_ts in created_chunks:
            if chunk["id"] == created_chunk["id"]:
                expected_timestamp = original_ts.isoformat()[:23] + "Z"
                assert chunk["timestamp"] == expected_timestamp
                assert chunk["transcript"] == created_chunk["transcript"]
                break

    # Test with file upload and timestamp
    file_timestamp = base_time + timedelta(minutes=30)
    file_obj = UploadFile(filename="test_with_timestamp.mp3", file=BytesIO(b"audio content"))

    with patch.object(conversation_service.file_service, "save") as mock_save:
        mock_save.return_value = "https://s3.example.com/test_with_timestamp.mp3"

        file_chunk = conversation_service.create_chunk(
            conversation_id=conversation["id"],
            file_obj=file_obj,
            timestamp=file_timestamp,
            source="AUDIO",
        )

        expected_file_timestamp = file_timestamp.isoformat()[:23] + "Z"
        assert file_chunk["timestamp"] == expected_file_timestamp

    # Verify the new chunk is included and sorted correctly
    fetched_with_file = conversation_service.get_by_id_or_raise(
        conversation["id"], with_chunks=True
    )
    assert len(fetched_with_file["chunks"]) == 6

    # The file chunk should be at the correct position based on its timestamp
    file_chunk_index = next(
        i for i, chunk in enumerate(fetched_with_file["chunks"]) if chunk["id"] == file_chunk["id"]
    )

    # Verify it's sorted correctly (should be second from the top since it's 30 minutes after base)
    assert file_chunk_index == 1  # Index 1 because one chunk is 1 hour after base

    conversation_service.delete(conversation["id"])


def test_chunk_timestamp_edge_cases(project):
    """Test edge cases for timestamp handling."""
    conversation = conversation_service.create(
        project_id=project["id"],
        participant_name="Test Participant",
    )

    # Test with microseconds - Directus will truncate to milliseconds
    timestamp_with_microseconds = datetime(2024, 1, 15, 10, 30, 45, 999999)
    chunk1 = conversation_service.create_chunk(
        conversation_id=conversation["id"],
        transcript="Chunk with microseconds",
        timestamp=timestamp_with_microseconds,
        source="TRANSCRIPT",
    )

    # Directus stores with millisecond precision and 'Z' suffix
    expected_timestamp = timestamp_with_microseconds.isoformat()[:23] + "Z"
    assert chunk1["timestamp"] == expected_timestamp

    # Test chunks created at the exact same time
    same_time = datetime(2024, 1, 15, 12, 0, 0)
    chunk2 = conversation_service.create_chunk(
        conversation_id=conversation["id"],
        transcript="First chunk at same time",
        timestamp=same_time,
        source="TRANSCRIPT",
    )

    chunk3 = conversation_service.create_chunk(
        conversation_id=conversation["id"],
        transcript="Second chunk at same time",
        timestamp=same_time,
        source="TRANSCRIPT",
    )

    # Both should have the same timestamp
    # Directus always adds milliseconds, even when original datetime doesn't have them
    expected_same_time = same_time.isoformat() + ".000Z"
    assert chunk2["timestamp"] == expected_same_time
    assert chunk3["timestamp"] == expected_same_time

    # Fetch and verify all chunks are present
    fetched = conversation_service.get_by_id_or_raise(conversation["id"], with_chunks=True)
    assert len(fetched["chunks"]) == 3

    # Verify chunks with same timestamp are both included
    same_time_chunks = [
        chunk for chunk in fetched["chunks"] if chunk["timestamp"] == expected_same_time
    ]
    assert len(same_time_chunks) == 2

    # Test very precise timestamps are handled consistently
    precise_time = datetime(2024, 1, 15, 14, 30, 25, 500000)  # Exactly 500ms
    chunk4 = conversation_service.create_chunk(
        conversation_id=conversation["id"],
        transcript="Chunk with precise half-second",
        timestamp=precise_time,
        source="TRANSCRIPT",
    )

    # Should be stored as .500Z
    expected_precise = precise_time.isoformat()[:23] + "Z"
    assert chunk4["timestamp"] == expected_precise
    assert ".500Z" in chunk4["timestamp"]

    conversation_service.delete(conversation["id"])
