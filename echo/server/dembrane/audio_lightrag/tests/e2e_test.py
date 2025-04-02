import pytest

from dembrane.audio_lightrag.main.run_etl import run_etl_pipeline


@pytest.mark.usefixtures("test_audio_uuid")
def test_run_etl_pipeline(test_audio_uuid: str) -> None:
    run_etl_pipeline([
        test_audio_uuid,
    ])
    
