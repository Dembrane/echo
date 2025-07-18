from logging import getLogger

import redis

from dembrane.config import (
    REDIS_URL,
    AUDIO_LIGHTRAG_REDIS_LOCK_EXPIRY,
    AUDIO_LIGHTRAG_REDIS_LOCK_PREFIX,
)
from dembrane.directus import directus

logger = getLogger(__name__)


def finish_conversation(conversation_id: str) -> None:
    directus.update_item(
        "conversation",
        conversation_id,
        {"is_audio_processing_finished": True},
    )


def renew_redis_lock(conversation_id: str) -> bool:
    """
    Ensure Redis lock exists for a conversation ID during processing.
    If lock doesn't exist (expired), recreate it.

    Args:
        conversation_id: The conversation ID to maintain the lock for

    Returns:
        bool: True if lock exists or was successfully created, False otherwise
    """
    try:
        redis_client = redis.from_url(REDIS_URL)
        lock_key = f"{AUDIO_LIGHTRAG_REDIS_LOCK_PREFIX}{conversation_id}"

        # Check if lock exists
        if redis_client.exists(lock_key):
            return True  # Lock exists, no action needed

        # Lock doesn't exist (expired), recreate it
        acquired = redis_client.set(lock_key, "1", ex=AUDIO_LIGHTRAG_REDIS_LOCK_EXPIRY, nx=True)
        if acquired:
            logger.info(f"Recreated Redis lock for conversation {conversation_id}")
            return True
        else:
            logger.warning(f"Failed to recreate Redis lock for conversation {conversation_id}")
            return False

    except Exception as e:
        logger.error(f"Error maintaining Redis lock for conversation {conversation_id}: {e}")
        return False
