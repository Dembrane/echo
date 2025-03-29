import pytest

from dembrane.audio_lightrag.pipelines.audio_etl_pipeline import AudioETLPipeline
from dembrane.audio_lightrag.pipelines.directus_etl_pipeline import DirectusETLPipeline
from dembrane.audio_lightrag.pipelines.contextual_chunk_etl_pipeline import (
    ContextualChunkETLPipeline,
)


@pytest.mark.usefixtures("test_audio_uuid")
def test_contextual_chunk_etl_pipeline(test_audio_uuid: str) -> None:
    directus_etl_pipeline = DirectusETLPipeline()
    process_tracker = directus_etl_pipeline.run([test_audio_uuid])
    audio_etl_pipeline = AudioETLPipeline(process_tracker)
    audio_etl_pipeline.run()
    contextual_chunk_pipeline = ContextualChunkETLPipeline(process_tracker)
    contextual_chunk_pipeline.run()
