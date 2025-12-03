import logging
from typing import List
from datetime import timedelta

from dembrane.utils import get_utc_timestamp
from dembrane.directus import directus

logger = logging.getLogger("dembrane.conversation_utils")


def collect_unfinished_conversations(limit: int = 100) -> List[str]:
    """
    Collect unfinished conversations that are ready to be finished.
    
    Args:
        limit: Maximum number of conversations to return (default 100).
               This prevents queue explosion when there are thousands of
               unfinished conversations. The scheduler runs frequently
               enough to catch up over multiple runs.
    
    Returns:
        List of conversation IDs ready to be finished.
    """
    # We want to collect:
    # 1. All unfinished conversations, EXCEPT
    # 2. Those that have at least one chunk in the last 5 minutes
    # 3. Ignore those who were just created (within the last 5 minutes)

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
                    # Must have been created more than 5 minutes ago
                    # (skip recently created conversations that might still be receiving chunks)
                    "created_at": {
                        "_lte": (get_utc_timestamp() - timedelta(minutes=5)).isoformat()
                    },
                },
                "fields": ["id"],
                "sort": ["created_at"],  # Process oldest first
                "limit": limit,
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
