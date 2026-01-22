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


def collect_conversations_needing_transcribed_flag(limit: int = 50) -> List[str]:
    """
    Collect conversations that should have is_all_chunks_transcribed=True but don't.
    
    This reconciliation task catches conversations where the normal finalization
    flow failed or was skipped. This handles:
    - Audio conversations where finalization task failed
    - TEXT conversations where all chunks have transcripts from direct input
    
    A conversation needs the flag set if:
    1. is_finished = True (user/scheduler marked it as done)
    2. is_all_chunks_transcribed = False (flag not yet set)
    3. All chunks have transcripts or errors (none are pending)
    4. Created more than 5 minutes ago (give normal flow time)
    
    Args:
        limit: Maximum number of conversations to return (default 50).
    
    Returns:
        List of conversation IDs needing the transcribed flag.
    """
    response = directus.get_items(
        "conversation",
        {
            "query": {
                "filter": {
                    "is_finished": True,
                    "is_all_chunks_transcribed": False,
                    "created_at": {
                        "_lte": (get_utc_timestamp() - timedelta(minutes=5)).isoformat()
                    },
                    # Must NOT have any chunks still pending (no transcript AND no error)
                    "chunks": {
                        "_none": {
                            "_and": [
                                {"transcript": {"_null": True}},
                                {"error": {"_null": True}}
                            ]
                        }
                    }
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
            logger.error(f"Error collecting conversation needing flag {conversation['id']}: {e}")
    
    logger.info(f"Found {len(conversation_ids)} conversations needing transcribed flag")
    
    return conversation_ids


def collect_unsummarized_conversations(limit: int = 50) -> List[str]:
    """
    Collect conversations that are fully transcribed but missing a summary.
    
    Simple check: is_all_chunks_transcribed = True AND summary = null.
    The transcribed flag is the source of truth for "ready for summarization".
    
    Args:
        limit: Maximum number of conversations to return (default 50).
    
    Returns:
        List of conversation IDs that need summarization.
    """
    response = directus.get_items(
        "conversation",
        {
            "query": {
                "filter": {
                    "is_all_chunks_transcribed": True,
                    "summary": {"_null": True},
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
            logger.error(f"Error collecting unsummarized conversation {conversation['id']}: {e}")
    
    logger.info(f"Found {len(conversation_ids)} unsummarized conversations")
    
    return conversation_ids
