import logging
from typing import List
from datetime import timedelta

from dembrane.utils import get_utc_timestamp
from dembrane.config import ENABLE_AUDIO_LIGHTRAG_INPUT
from dembrane.directus import directus

logger = logging.getLogger("dembrane.conversation_utils")


def collect_unfinished_conversations() -> List[str]:
    # We want to collect:
    # 1. All unfinished conversations, EXCEPT
    # 2. Those that have at least one chunk in the last 5 minutes

    response = directus.get_items(
        "conversation",
        {
            "query": {
                "filter": {
                    # Must be unfinished
                    "is_finished": False,
                    # Must not have a chunk in the last 5 minutes :)
                    "chunks": {
                        "_none": {
                            "timestamp": {
                                "_gte": (get_utc_timestamp() - timedelta(minutes=5)).isoformat()
                            }
                        }
                    },
                },
                "fields": ["id"],
                "limit": -1,
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
    # Match task_run_etl_pipeline logic: check both global AND project flags
    # This prevents infinite loops where collector picks up conversations
    # that the task will immediately mark as finished (RAG disabled)
    if not ENABLE_AUDIO_LIGHTRAG_INPUT:
        logger.info("ENABLE_AUDIO_LIGHTRAG_INPUT is False, skipping RAG collection")
        return []
    
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
                logger.warning(f"Found {len(response)} segments with lightrag_flag=False for conversation {conversation['id']} (marked as finished={conversation.get('is_audio_processing_finished')})")
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
