import logging
from typing import Optional

import redis

from dembrane.config import (
    REDIS_URL,
    AUDIO_LIGHTRAG_REDIS_LOCK_EXPIRY,
    AUDIO_LIGHTRAG_REDIS_LOCK_PREFIX,
)
from dembrane.audio_lightrag.pipelines.audio_etl_pipeline import AudioETLPipeline
from dembrane.audio_lightrag.pipelines.directus_etl_pipeline import DirectusETLPipeline
from dembrane.audio_lightrag.pipelines.contextual_chunk_etl_pipeline import (
    ContextualChunkETLPipeline,
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)



def run_etl_pipeline(conv_id_list: list[str]) -> Optional[bool]:
    """
    Runs the complete ETL pipeline including Directus, Audio, and Contextual Chunk processes.
    Uses Redis locks to prevent the same conversation ID from being processed within 1 hour.
    
    Args:
        conv_id_list: List of conversation IDs to process
        
    Returns:
        bool: True if pipeline completes successfully, False if there's an error
        None: If input validation fails
    """
    try:
        if not conv_id_list:
            logger.error("Empty conversation ID list provided")
            return None

        # Filter conversation IDs that are already being processed (via Redis locks)
        redis_client = redis.from_url(REDIS_URL)
        filtered_conv_ids = []
        
        for conv_id in conv_id_list:
            lock_key = f"{AUDIO_LIGHTRAG_REDIS_LOCK_PREFIX}{conv_id}"
            # Atomically acquire the lock - fail fast if someone already owns it
            acquired = redis_client.set(lock_key, "1", ex=AUDIO_LIGHTRAG_REDIS_LOCK_EXPIRY, nx=True)
            if not acquired:
                # Check TTL for informative logging
                ttl = redis_client.ttl(lock_key)
                if ttl > 0:
                    minutes_remaining = round(ttl / 60)
                    logger.info(f"Skipping conversation ID {conv_id}: already processed or being processed. Lock expires in ~{minutes_remaining} minutes.")
                else:
                    logger.info(f"Race-lost lock for {conv_id}, skipping.")
                continue
            
            filtered_conv_ids.append(conv_id)
        
        if not filtered_conv_ids:
            logger.info(
                "All conversation IDs are already being processed or locked. Nothing to do."
            )
            return True
            
        logger.info(f"Starting ETL pipeline for {len(filtered_conv_ids)} conversations (after filtering)")
        
        # Directus Pipeline
        try:
            directus_pl = DirectusETLPipeline()
            process_tracker = directus_pl.run(
                filtered_conv_ids,
                run_timestamp=None,  # pass timestamp to avoid processing files uploaded earlier than cooloff
            )
            logger.info("1/3...Directus ETL pipeline completed successfully")
        except Exception as e:
            logger.error(f"Directus ETL pipeline failed: {str(e)}")
            raise

        # Audio Pipeline
        try:
            audio_pl = AudioETLPipeline(process_tracker)
            audio_pl.run()
            logger.info("2/3...Audio ETL pipeline completed successfully")
        except Exception as e:
            logger.error(f"Audio ETL pipeline failed: {str(e)}")
            raise

        # Contextual Chunk Pipeline
        try:
            contextual_chunk_pl = ContextualChunkETLPipeline(process_tracker)
            contextual_chunk_pl.run()
            logger.info("3/3...Contextual Chunk ETL pipeline completed successfully")
        except Exception as e:
            logger.error(f"Contextual Chunk ETL pipeline failed: {str(e)}")
            raise

        logger.info("All ETL pipelines completed successfully")
        return True

    except Exception as e:
        logger.error(f"ETL pipeline failed with error: {str(e)}")
        # Release locks for all IDs in case of failure to allow retries
        try:
            redis_client = redis.from_url(REDIS_URL)
            for conv_id in filtered_conv_ids:
                redis_client.delete(f"{AUDIO_LIGHTRAG_REDIS_LOCK_PREFIX}{conv_id}")
            logger.info("Released Redis locks due to failure")
        except Exception as release_err:
            logger.error(f"Failed to release Redis locks: {str(release_err)}")
        return False


if __name__ == "__main__":
    # Steps for manual run
    # cd server 
    # python -m dembrane.audio_lightrag.main.run_etl
    import os

    from dotenv import load_dotenv
    load_dotenv()

    TEST_CONV_UUID = str(os.getenv("TEST_CONV_UUID"))
    conv_id_list: list[str] = [TEST_CONV_UUID]
    run_etl_pipeline(conv_id_list)
