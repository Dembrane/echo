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

    """
    Retrieves IDs of unfinished conversations from enhanced audio projects without recent activity.
    
    Returns:
        List of conversation IDs that are unfinished, belong to projects with enhanced audio processing enabled, and have no associated chunks with timestamps in the last 15 minutes.
    """
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

    conversation_ids = [conversation["id"] for conversation in response]
    logger.info(f"Found {len(conversation_ids)} unfinished conversations")

    return conversation_ids


if __name__ == "__main__":
    print(collect_unfinished_conversations())
    pass
