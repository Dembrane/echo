import logging
from typing import List
from datetime import timedelta

from dembrane.utils import get_utc_timestamp
from dembrane.directus import directus

logger = logging.getLogger("dembrane.conversation_utils")


def collect_unfinished_conversations() -> List[str]:
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
