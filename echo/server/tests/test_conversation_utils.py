import logging
from datetime import timedelta

import pytest

from dembrane.utils import get_utc_timestamp
from dembrane.directus import directus
from dembrane.conversation_utils import (
    collect_unfinished_conversations,
    collect_unfinished_audio_processing_conversations,
)

from .common import (
    create_project,
    delete_project,
    create_conversation,
    delete_conversation,
    delete_conversation_chunk,
    create_conversation_segment,
    delete_conversation_segment,
)

logger = logging.getLogger("test_conversation_utils")

pytestmark = pytest.mark.integration


def test_create_conversation_chunk():
    # Create test project
    p = create_project(
        "test_p",
        "en",
    )

    # Create test conversation
    c = create_conversation(
        p["id"],
        "test_c",
    )

    # Create timestamp 1 hour and 16 minutes in the past
    cc_timestamp = (get_utc_timestamp() - timedelta(hours=1, minutes=16)).isoformat()

    # Log timestamp being sent
    logger.info(f"Sending timestamp: {cc_timestamp}")

    # Create conversation chunk
    cc = directus.create_item(
        "conversation_chunk",
        {
            "transcript": "test_cc",
            "conversation_id": c["id"],
            "timestamp": cc_timestamp,
        },
    )["data"]

    # Log timestamp received
    logger.info(f"Received timestamp: {cc['timestamp']}")

    # Basic validations
    assert cc["id"] is not None, "No ID returned"
    assert cc["transcript"] == "test_cc", "Transcript mismatch"
    assert cc["conversation_id"] == c["id"], "Conversation ID mismatch"

    # Just validate the timestamp format without comparing values
    assert isinstance(cc["timestamp"], str), "Timestamp should be a string"
    assert "T" in cc["timestamp"], "Not a valid ISO timestamp format"

    # Clean up
    delete_conversation_chunk(cc["id"])
    delete_conversation(c["id"])
    delete_project(p["id"])


"""
I found an extremely weird bug. 
When using the Directus API to update fields that have onCreate/onUpdate hooks
(or special attributes like date-created/date-updated) applied to them, 
Directus silently ignores the values you pass in your JSON payload. 
Instead, Directus will use its own internal logic to set these field values, 
regardless of what you explicitly provide in your API request.
"""


def test_collect_unfinished_conversations():
    fail_p = create_project(
        "fail_p",
        "en",
        additional_data={"is_enhanced_audio_processing_enabled": False},
    )

    fail_c = create_conversation(fail_p["id"], "fail_c")

    fail_timestamp = (get_utc_timestamp() - timedelta(minutes=16)).isoformat()
    fail_cc = directus.create_item(
        "conversation_chunk",
        {
            "transcript": "fail_cc",
            "conversation_id": fail_c["id"],
            "timestamp": fail_timestamp,
        },
    )["data"]

    res = collect_unfinished_conversations()

    assert fail_c["id"] not in res

    delete_conversation_chunk(fail_cc["id"])
    delete_conversation(fail_c["id"])
    delete_project(fail_p["id"])

    p = create_project(
        "test_p",
        "en",
        additional_data={"is_enhanced_audio_processing_enabled": True},
    )

    c = create_conversation(p["id"], "test_c")

    res = collect_unfinished_conversations()

    assert c["id"] in res, "Conversation with no chunks"

    delete_conversation(c["id"])

    c = create_conversation(p["id"], "test_c")
    cc_timestamp = (get_utc_timestamp() - timedelta(hours=1)).isoformat()
    cc = directus.create_item(
        "conversation_chunk",
        {
            "transcript": "test_cc",
            "conversation_id": c["id"],
            "timestamp": cc_timestamp,
        },
    )["data"]
    res = collect_unfinished_conversations()

    assert c["id"] in res, "Conversation with one chunk (>1hr old)"

    cc_timestamp = (get_utc_timestamp() - timedelta(minutes=16)).isoformat()
    cc2 = directus.create_item(
        "conversation_chunk",
        {
            "transcript": "test_cc2",
            "conversation_id": c["id"],
            "timestamp": cc_timestamp,
        },
    )["data"]

    res = collect_unfinished_conversations()

    assert c["id"] in res, "TEST 15min: Conversation with two chunks (1hr old, 16min old)"

    logger.info("current time = %s", get_utc_timestamp())
    cc_timestamp = (get_utc_timestamp() - timedelta(minutes=10)).isoformat()
    logger.info("cc_timestamp = %s", cc_timestamp)
    cc3 = directus.create_item(
        "conversation_chunk",
        {
            "transcript": "test_cc",
            "conversation_id": c["id"],
            "timestamp": cc_timestamp,
        },
    )["data"]
    res = collect_unfinished_conversations()

    assert (
        c["id"] not in res
    ), "TEST 10min: Conversation with two chunks (1hr old, 16min old, 10min old)"

    delete_conversation_chunk(cc["id"])
    delete_conversation_chunk(cc2["id"])
    delete_conversation_chunk(cc3["id"])
    delete_conversation(c["id"])
    delete_project(p["id"])


def test_collect_unfinished_audio_processing_conversations():
    # Setup project with enhanced audio processing enabled
    p = create_project(
        "test_p",
        "en",
        additional_data={"is_enhanced_audio_processing_enabled": True},
    )

    # Conversation with audio processing not finished should be returned
    c1 = create_conversation(
        p["id"],
        "c1_test",
        additional_data={"is_audio_processing_finished": False},
    )

    # Conversation marked finished but has unprocessed segment
    c2 = create_conversation(
        p["id"],
        "c2_test",
        additional_data={"is_audio_processing_finished": True},
    )
    seg2 = create_conversation_segment(c2["id"], False)

    # Conversation marked finished and all segments processed
    c3 = create_conversation(
        p["id"],
        "c3_test",
        additional_data={"is_audio_processing_finished": True},
    )
    seg3 = create_conversation_segment(c3["id"], True)

    res = collect_unfinished_audio_processing_conversations()

    assert c1["id"] in res, "Conversation with unfinished processing not returned"
    assert c2["id"] in res, "Conversation with unprocessed segments not returned"
    assert c3["id"] not in res, "Conversation with all segments processed should not be returned"

    # Cleanup
    delete_conversation_segment(seg2["id"])
    delete_conversation_segment(seg3["id"])
    delete_conversation(c1["id"])
    delete_conversation(c2["id"])
    delete_conversation(c3["id"])
    delete_project(p["id"])
