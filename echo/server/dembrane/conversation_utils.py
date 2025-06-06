import logging
from typing import List
from datetime import timedelta

from dembrane.utils import get_utc_timestamp
from dembrane.directus import directus

logger = logging.getLogger("dembrane.conversation_utils")


def collect_unfinished_conversations() -> List[str]:
    # We want to collect:
    # 1. All unfinished conversations from enhanced audio projects by default, EXCEPT
    # 2. Those that have at least one chunk in the last 15 minutes

    response = directus.get_items(
        "conversation",
        {
            "query": {
                "filter": {
                    # Must be unfinished
                    "is_finished": False,
                    # Must be from a project with enhanced audio enabled
                    "project_id": {
                        "is_enhanced_audio_processing_enabled": True,
                    },
                    # Must not have a chunk in the last 15 minutes :)
                    "chunks": {
                        "_none": {
                            "timestamp": {
                                "_gte": (get_utc_timestamp() - timedelta(minutes=15)).isoformat()
                            }
                        }
                    },
                },
                "fields": ["id"],
                "limit": 100000,
            },
        },
    )

    conversation_ids = []

    for conversation in response:
        try:
            conversation_ids.append(conversation["id"])
        except Exception as e:
            logger.error(f"Error collecting conversation {conversation['id']}: {e}")

    logger.info(f"Found {len(conversation_ids)} unfinished conversations")

    return conversation_ids

def collect_unfinished_audio_processing_conversations() -> List[str]:
    unfinished_conversations = []

    # if they are already in process
    response = directus.get_items(
        "conversation",
        {
            "query": {
                "filter": {
                    "project_id": {
                        "is_enhanced_audio_processing_enabled": True,
                    },
                },
                "fields": ["id", "is_audio_processing_finished"],
            },
        },
    )

    for conversation in response:
        try:
            if not conversation["is_audio_processing_finished"]:
                unfinished_conversations.append(conversation["id"])
                continue  # and move to next conversation
        except Exception as e:
            logger.error(f"Error collecting conversation {conversation['id']}: {e}")
            continue

        # if claimed "is_audio_processing_finished" but not actually finished
        try:
            response = directus.get_items(
                "conversation_segment",
                {
                    "query": {
                        "filter": {"conversation_id": conversation["id"], "lightrag_flag": False},
                        "fields": ["id"],
                        "limit": 1,
                    },
                },
            )


        # Only add if there is at least one unprocessed segment
            if response and len(response) > 0:
                unfinished_conversations.append(conversation["id"])
        except Exception as e:
            logger.error(f"Error collecting conversation {conversation['id']}: {e}")
        
        try:
            total_segments = directus.get_items(
                "conversation_segment",
                {"query": {"filter": {"conversation_id": conversation["id"]}, "limit": 1}},
            )

            if len(total_segments) == 0:
                unfinished_conversations.append(conversation["id"])

                directus.update_item(
                    "conversation",
                    conversation["id"],
                    {"is_audio_processing_finished": False},
                )
        except Exception as e:
            logger.error(f"Error collecting conversation {conversation['id']}: {e}")

    return list(set(unfinished_conversations))

