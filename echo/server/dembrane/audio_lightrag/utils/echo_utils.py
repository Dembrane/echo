from logging import getLogger

import redis

from dembrane.config import (
    REDIS_URL,
    AUDIO_LIGHTRAG_REDIS_LOCK_EXPIRY,
    AUDIO_LIGHTRAG_REDIS_LOCK_PREFIX,
)
from dembrane.directus import directus

logger = getLogger(__name__)

_redis_client: redis.Redis | None = None


def _get_redis_client() -> redis.Redis:
    global _redis_client
    if _redis_client is None:
        _redis_client = redis.from_url(REDIS_URL)
    return _redis_client


def finish_conversation(conversation_id: str) -> None:
    try:
        directus.update_item(
            "conversation",
            conversation_id,
            {"is_audio_processing_finished": True},
        )
    except Exception as e:
        logger.error(f"Failed to finish conversation {conversation_id}: {e}")
        raise


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
        redis_client = _get_redis_client()
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


def release_redis_lock(conversation_id: str) -> None:
    try:
        redis_client = _get_redis_client()
        lock_key = f"{AUDIO_LIGHTRAG_REDIS_LOCK_PREFIX}{conversation_id}"
        if redis_client.exists(lock_key):
            redis_client.delete(lock_key)
            logger.info(f"Released Redis lock for conversation {conversation_id}")
        else:
            logger.warning(f"Redis lock for conversation {conversation_id} does not exist")
    except Exception as e:
        logger.error(f"Error releasing Redis lock for conversation {conversation_id}: {e}")
        raise
