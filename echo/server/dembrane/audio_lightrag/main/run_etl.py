from dotenv import load_dotenv

from dembrane.audio_lightrag.pipelines.audio_etl_pipeline import AudioETLPipeline
from dembrane.audio_lightrag.pipelines.directus_etl_pipeline import DirectusETLPipeline

# from dembrane.audio_lightrag.pipelines.lightrag_etl_pipeline import LightragETLPipeline
from dembrane.audio_lightrag.pipelines.contextual_chunk_etl_pipeline import (
    ContextualChunkETLPipeline,
)

load_dotenv()

def run_etl_pipeline(conv_id_list: list[str]) -> None:
    """
    Runs the complete ETL pipeline including Directus, Audio, Contextual Chunk, and Lightrag processes.
    """
    directus_pl = DirectusETLPipeline()
    process_tracker = directus_pl.run(conv_id_list)
    audio_pl = AudioETLPipeline(process_tracker)
    audio_pl.run()
    contextual_chunk_pl = ContextualChunkETLPipeline(process_tracker)
    contextual_chunk_pl.run()
