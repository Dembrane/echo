import logging
from io import BytesIO
from datetime import datetime, timezone, timedelta
from unittest.mock import Mock, patch

import pytest
from fastapi import UploadFile

from dembrane.utils import get_utc_timestamp
from dembrane.service import project_service, conversation_service
from dembrane.directus import DirectusBadRequest
from dembrane.service.conversation import (
    ConversationService,
    ConversationNotFoundException,
    ConversationNotOpenForParticipationException,
    stamp_recording_started_at,
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


@pytest.mark.integration
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


@pytest.mark.integration
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


@pytest.mark.integration
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


@pytest.mark.integration
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


@pytest.mark.integration
def test_get_by_id_or_raise_not_found():
    try:
        conversation_service.get_by_id_or_raise("non-existent-id")
    except Exception as e:
        assert isinstance(e, ConversationNotFoundException)


@pytest.mark.integration
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


@pytest.mark.integration
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


@pytest.mark.integration
def test_update_conversation_not_found():
    with pytest.raises(ConversationNotFoundException):
        conversation_service.update(
            conversation_id="non-existent-id",
            participant_name="Updated Name",
        )


@pytest.mark.integration
def test_delete_conversation(project):
    conversation = conversation_service.create(
        project_id=project["id"],
        participant_name="Test Participant",
    )

    conversation_service.delete(conversation["id"])

    with pytest.raises(ConversationNotFoundException):
        conversation_service.get_by_id_or_raise(conversation["id"])


# Unit test - tests service initialization with dependencies
def test_conversation_service_property_getters():
    """Test that service dependencies are properly set on initialization."""
    from dembrane.service.file import get_file_service
    from dembrane.service.project import ProjectService

    # Create service instances
    file_service = get_file_service()
    project_svc = ProjectService()

    # Create conversation service with dependencies
    service = ConversationService(
        file_service=file_service,
        project_service=project_svc,
    )

    # Verify services are set correctly
    assert service.file_service is not None
    assert service.project_service is not None
    assert service.file_service is file_service
    assert service.project_service is project_svc


# Unit test - uses mocks, no external dependencies
def test_get_by_id_directus_bad_request():
    """Test exception handling when Directus returns bad request."""
    with patch("dembrane.service.conversation.directus_client_context") as mock_context:
        mock_client = Mock()
        mock_client.get_items.side_effect = DirectusBadRequest("Bad request")
        mock_context().__enter__.return_value = mock_client

        with pytest.raises(ConversationNotFoundException):
            conversation_service.get_by_id_or_raise("test-id")


# Unit test - uses mocks, no external dependencies
def test_get_by_id_empty_result():
    """Test exception handling when no conversation found."""
    with patch("dembrane.service.conversation.directus_client_context") as mock_context:
        mock_client = Mock()
        mock_client.get_items.return_value = []
        mock_context().__enter__.return_value = mock_client

        with pytest.raises(ConversationNotFoundException):
            conversation_service.get_by_id_or_raise("test-id")


# Unit test - uses mocks, no external dependencies
def test_update_conversation_directus_bad_request():
    """Test exception handling when updating non-existent conversation."""
    with patch("dembrane.service.conversation.directus_client_context") as mock_context:
        mock_client = Mock()
        mock_client.update_item.side_effect = DirectusBadRequest("Not found")
        mock_context().__enter__.return_value = mock_client

        with pytest.raises(ConversationNotFoundException):
            conversation_service.update(conversation_id="non-existent-id", participant_name="Test")


# Unit test - uses mocks for S3 and events, but still needs DB for conversation
@pytest.mark.integration
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


@pytest.mark.integration
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


# Uses mock for events, but still needs DB for conversation
@pytest.mark.integration
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


@pytest.mark.integration
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


@pytest.mark.integration
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


@pytest.mark.integration
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


@pytest.mark.integration
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


@pytest.mark.integration
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


def _mock_directus():
    """Patch the client context so the conditional PATCH is captured, not sent."""
    context = patch("dembrane.service.conversation.directus_client_context")
    mock_context = context.start()
    mock_client = Mock()
    mock_context.return_value.__enter__.return_value = mock_client
    return context, mock_client


def _patch_body(mock_client):
    return mock_client.patch.call_args.kwargs["json"]


def _stamped_value(mock_client):
    return _patch_body(mock_client)["data"]["recording_started_at"]


def _stampable_conversation(**overrides):
    conversation = {
        "id": "conv-1",
        "created_at": "2024-01-01T00:00:00Z",
        "recording_started_at": None,
    }
    conversation.update(overrides)
    return conversation


def test_stamp_recording_started_at_sets_when_null():
    """First chunk stamps recording_started_at from the chunk timestamp."""
    conversation = _stampable_conversation()
    timestamp = datetime(2024, 1, 15, 14, 30, 25)

    context, mock_client = _mock_directus()
    try:
        conversation_service._stamp_recording_started_at(conversation, timestamp)

        mock_client.patch.assert_called_once()
        assert mock_client.patch.call_args.args[0] == "/items/conversation"
        assert _stamped_value(mock_client) == timestamp.replace(tzinfo=timezone.utc).isoformat()
    finally:
        context.stop()


def test_stamp_recording_started_at_does_not_overwrite():
    """A later chunk leaves an existing recording_started_at alone."""
    conversation = _stampable_conversation(recording_started_at="2024-01-15T14:30:25Z")

    context, mock_client = _mock_directus()
    try:
        conversation_service._stamp_recording_started_at(
            conversation, datetime(2024, 1, 15, 15, 0, 0)
        )

        mock_client.patch.assert_not_called()
    finally:
        context.stop()


def test_chunk_path_write_is_fill_if_empty():
    """A skewed client timestamp must not overwrite an existing (trusted) stamp."""
    conversation = _stampable_conversation()

    context, mock_client = _mock_directus()
    try:
        conversation_service._stamp_recording_started_at(
            conversation, datetime(2024, 1, 15, 14, 30, 25)
        )

        conditions = _patch_body(mock_client)["query"]["filter"]["_and"]
        assert {"id": {"_eq": "conv-1"}} in conditions
        assert {"recording_started_at": {"_null": True}} in conditions
        assert not any("_gt" in str(condition) for condition in conditions)
    finally:
        context.stop()


def test_liveness_path_may_move_the_stamp_earlier():
    """The server-clocked caller also wins over a later stored value."""
    context, mock_client = _mock_directus()
    try:
        stamp_recording_started_at(
            "conv-1",
            datetime(2024, 1, 15, 14, 30, 25, tzinfo=timezone.utc),
            allow_moving_earlier=True,
        )

        conditions = _patch_body(mock_client)["query"]["filter"]["_and"]
        assert {
            "_or": [
                {"recording_started_at": {"_null": True}},
                {"recording_started_at": {"_gt": "2024-01-15T14:30:25+00:00"}},
            ]
        } in conditions
    finally:
        context.stop()


def test_stamp_filter_excludes_dashboard_uploads():
    """Enforcement lives in the filter, so no caller can stamp an upload."""
    context, mock_client = _mock_directus()
    try:
        stamp_recording_started_at("conv-1", datetime(2024, 1, 15, 14, 30, 25, tzinfo=timezone.utc))

        conditions = _patch_body(mock_client)["query"]["filter"]["_and"]
        assert {
            "_or": [
                {"source": {"_null": True}},
                {"source": {"_neq": "DASHBOARD_UPLOAD"}},
            ]
        } in conditions
    finally:
        context.stop()


def test_stamp_logs_warning_on_unexpected_directus_error(caplog):
    """A 403/500 must be visible, not swallowed as 'column not deployed'."""
    context, mock_client = _mock_directus()
    try:
        mock_client.patch.side_effect = DirectusBadRequest("403 Forbidden")
        with caplog.at_level(logging.WARNING, logger="dembrane.service.conversation"):
            stamp_recording_started_at(
                "conv-1", datetime(2024, 1, 15, 14, 30, 25, tzinfo=timezone.utc)
            )
        assert any("403 Forbidden" in record.getMessage() for record in caplog.records)
    finally:
        context.stop()


def test_stamp_stays_quiet_when_column_not_deployed(caplog):
    """The pre-migration unknown-field error is expected, so no warning."""
    context, mock_client = _mock_directus()
    try:
        mock_client.patch.side_effect = DirectusBadRequest(
            'Invalid query. Field "recording_started_at" does not exist in collection "conversation".'
        )
        with caplog.at_level(logging.WARNING, logger="dembrane.service.conversation"):
            stamp_recording_started_at(
                "conv-1", datetime(2024, 1, 15, 14, 30, 25, tzinfo=timezone.utc)
            )
        assert caplog.records == []
    finally:
        context.stop()


def test_stamp_recording_started_at_skips_when_column_missing():
    """Migration not applied: the key is absent and no PATCH is attempted."""
    conversation = {"id": "conv-1", "created_at": "2024-01-01T00:00:00Z"}

    context, mock_client = _mock_directus()
    try:
        conversation_service._stamp_recording_started_at(
            conversation, datetime(2024, 1, 15, 14, 30, 25)
        )

        mock_client.patch.assert_not_called()
    finally:
        context.stop()


def test_stamp_recording_started_at_skips_dashboard_upload():
    """Uploaded conversations are never stamped; upload time is not a recording start."""
    conversation = _stampable_conversation(source="DASHBOARD_UPLOAD")

    context, mock_client = _mock_directus()
    try:
        conversation_service._stamp_recording_started_at(
            conversation, datetime(2024, 1, 15, 14, 30, 25)
        )

        mock_client.patch.assert_not_called()
    finally:
        context.stop()


def test_stamp_recording_started_at_swallows_directus_failure():
    """A stamp failure must never fail the chunk upload."""
    conversation = _stampable_conversation()

    context, mock_client = _mock_directus()
    try:
        mock_client.patch.side_effect = RuntimeError("directus down")
        conversation_service._stamp_recording_started_at(
            conversation, datetime(2024, 1, 15, 14, 30, 25)
        )
    finally:
        context.stop()


def test_stamp_recording_started_at_clamps_future_client_clock():
    """A device clock running years ahead cannot stamp a far-future time."""
    conversation = _stampable_conversation()
    future = get_utc_timestamp() + timedelta(days=365)

    context, mock_client = _mock_directus()
    try:
        conversation_service._stamp_recording_started_at(conversation, future)

        written = _stamped_value(mock_client)
        assert datetime.fromisoformat(written) < get_utc_timestamp() + timedelta(minutes=10)
    finally:
        context.stop()


def test_stamp_recording_started_at_floors_past_client_clock():
    """A device clock stuck in the past floors at the conversation's created_at."""
    conversation = _stampable_conversation(created_at="2024-01-15T14:00:00Z")

    context, mock_client = _mock_directus()
    try:
        conversation_service._stamp_recording_started_at(
            conversation, datetime(2001, 6, 1, 9, 0, 0)
        )

        assert _stamped_value(mock_client) == "2024-01-15T14:00:00+00:00"
    finally:
        context.stop()


def test_stamp_recording_started_at_normalizes_offset_to_utc():
    """A client sending +02:00 is stored as the equivalent UTC time."""
    conversation = _stampable_conversation()

    context, mock_client = _mock_directus()
    try:
        conversation_service._stamp_recording_started_at(
            conversation,
            datetime.fromisoformat("2024-01-15T16:30:25+02:00"),
        )

        assert _stamped_value(mock_client) == "2024-01-15T14:30:25+00:00"
    finally:
        context.stop()


def _create_chunk_with_mocks(**kwargs):
    """Run create_chunk against mocked Directus; returns the stamp mock."""
    context, mock_client = _mock_directus()
    mock_client.create_item.return_value = {"data": {"id": "chunk-1"}}
    try:
        with (
            patch.object(
                conversation_service,
                "get_by_id_or_raise",
                return_value=_stampable_conversation(project_id="proj-1"),
            ),
            patch.object(
                conversation_service.project_service,
                "get_by_id_or_raise",
                return_value={"is_conversation_allowed": True},
            ),
            patch.object(conversation_service, "_clear_conversation_token_count"),
            patch.object(conversation_service, "_stamp_recording_started_at") as stamp,
            patch("dembrane.tasks.task_process_conversation_chunk"),
        ):
            conversation_service.create_chunk(
                conversation_id="conv-1",
                timestamp=datetime(2024, 1, 15, 14, 30, 25),
                **kwargs,
            )
            return stamp
    finally:
        context.stop()


def test_create_chunk_does_not_stamp_for_text_chunk():
    """A typed portal message must never set recording_started_at."""
    stamp = _create_chunk_with_mocks(source="PORTAL_TEXT", transcript="hello")
    stamp.assert_not_called()


def test_create_chunk_stamps_for_audio_chunk():
    stamp = _create_chunk_with_mocks(
        source="PORTAL_AUDIO", file_url="https://s3.example.com/chunk.webm"
    )
    stamp.assert_called_once()


@pytest.mark.integration
def test_create_chunk_stamps_recording_started_at_once(project):
    """First audio chunk sets recording_started_at; the second does not move it."""
    conversation = conversation_service.create(
        project_id=project["id"],
        participant_name="Test Participant",
    )

    first_timestamp = get_utc_timestamp()
    with patch.object(conversation_service.file_service, "save") as mock_save:
        mock_save.return_value = "https://s3.example.com/first.mp3"
        conversation_service.create_chunk(
            conversation_id=conversation["id"],
            file_obj=UploadFile(filename="first.mp3", file=BytesIO(b"audio content")),
            timestamp=first_timestamp,
            source="PORTAL_AUDIO",
        )

    stamped = conversation_service.get_by_id_or_raise(conversation["id"])["recording_started_at"]
    assert stamped is not None

    with patch.object(conversation_service.file_service, "save") as mock_save:
        mock_save.return_value = "https://s3.example.com/second.mp3"
        conversation_service.create_chunk(
            conversation_id=conversation["id"],
            file_obj=UploadFile(filename="second.mp3", file=BytesIO(b"audio content")),
            timestamp=first_timestamp + timedelta(minutes=5),
            source="PORTAL_AUDIO",
        )

    unchanged = conversation_service.get_by_id_or_raise(conversation["id"])
    assert unchanged["recording_started_at"] == stamped

    # a text chunk must not move it either
    conversation_service.create_chunk(
        conversation_id=conversation["id"],
        transcript="typed message",
        timestamp=first_timestamp - timedelta(minutes=5),
        source="PORTAL_TEXT",
    )
    still_unchanged = conversation_service.get_by_id_or_raise(conversation["id"])
    assert still_unchanged["recording_started_at"] == stamped

    conversation_service.delete(conversation["id"])
