import logging
from datetime import timedelta

from dembrane.utils import get_utc_timestamp
from dembrane.directus import directus
from dembrane.conversation_utils import collect_unfinished_conversations

from .common import (
    create_project,
    delete_project,
    create_conversation,
    delete_conversation,
    delete_conversation_chunk,
)

logger = logging.getLogger("test_conversation_utils")


def test_create_conversation_chunk():
    # Create test project
    """
    Tests the creation of a conversation chunk with a specific timestamp and validates its properties.
    
    This test creates a project and conversation, generates a timestamp in the past, and creates a conversation chunk with that timestamp. It asserts that the chunk is created with the correct transcript, conversation ID, and a valid ISO-formatted timestamp. All created resources are deleted after the test.
    """
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
    """
    Tests the logic for collecting unfinished conversations based on conversation chunk timestamps.
    
    Creates a project and conversation, then verifies that the conversation is considered unfinished until a recent chunk is added. Adds conversation chunks with varying timestamps and asserts the conversation's presence or absence in the unfinished conversations list after each addition. Cleans up all created resources at the end.
    """
    p = create_project(
        "test_p",
        "en",
        additional_data={"is_enhanced_audio_processing_enabled": True},
    )

    c = create_conversation(p["id"], "test_c")

    res = collect_unfinished_conversations()

    assert c["id"] in res

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

    assert c["id"] in res

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

    assert c["id"] in res

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

    assert c["id"] not in res

    delete_conversation_chunk(cc["id"])
    delete_conversation_chunk(cc2["id"])
    delete_conversation_chunk(cc3["id"])
    delete_conversation(c["id"])
    delete_project(p["id"])
