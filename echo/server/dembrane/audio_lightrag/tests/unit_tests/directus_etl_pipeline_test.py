import unittest

import pytest

from dembrane.audio_lightrag.pipelines.directus_etl_pipeline import DirectusETLPipeline


class TestDirectusETLPipeline:
    @pytest.fixture
    def directus_etl_pipeline(self) -> DirectusETLPipeline:
        return DirectusETLPipeline()
    @pytest.mark.usefixtures("test_audio_uuid")
    def test_run(self, directus_etl_pipeline: DirectusETLPipeline, 
                test_audio_uuid: str) -> None:
        process_tracker = directus_etl_pipeline.run([test_audio_uuid], 
                                                    run_timestamp="2025-03-20 14:01:39.750000+0000") #Test new and old timestamp
        assert process_tracker().shape[0] * process_tracker().shape[1] > 0

if __name__ == '__main__':
    unittest.main()
