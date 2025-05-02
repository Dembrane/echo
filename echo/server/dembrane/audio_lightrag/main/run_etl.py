import logging
from typing import Optional

from dotenv import load_dotenv

from dembrane.audio_lightrag.pipelines.audio_etl_pipeline import AudioETLPipeline
from dembrane.audio_lightrag.pipelines.directus_etl_pipeline import DirectusETLPipeline

# from dembrane.audio_lightrag.pipelines.lightrag_etl_pipeline import LightragETLPipeline
from dembrane.audio_lightrag.pipelines.contextual_chunk_etl_pipeline import (
    ContextualChunkETLPipeline,
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

load_dotenv()

def run_etl_pipeline(conv_id_list: list[str]) -> Optional[bool]:
    """
    Runs the complete ETL pipeline including Directus, Audio, and Contextual Chunk processes.
    
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

        logger.info(f"Starting ETL pipeline for {len(conv_id_list)} conversations")
        
        # Directus Pipeline
        try:
            directus_pl = DirectusETLPipeline()
            process_tracker = directus_pl.run(conv_id_list)
            logger.info("Directus ETL pipeline completed successfully")
        except Exception as e:
            logger.error(f"Directus ETL pipeline failed: {str(e)}")
            raise

        # Audio Pipeline
        try:
            audio_pl = AudioETLPipeline(process_tracker)
            audio_pl.run()
            logger.info("Audio ETL pipeline completed successfully")
        except Exception as e:
            logger.error(f"Audio ETL pipeline failed: {str(e)}")
            raise

        # Contextual Chunk Pipeline
        try:
            contextual_chunk_pl = ContextualChunkETLPipeline(process_tracker)
            contextual_chunk_pl.run()
            logger.info("Contextual Chunk ETL pipeline completed successfully")
        except Exception as e:
            logger.error(f"Contextual Chunk ETL pipeline failed: {str(e)}")
            raise

        logger.info("All ETL pipelines completed successfully")
        return True

    except Exception as e:
        logger.error(f"ETL pipeline failed with error: {str(e)}")
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
