import os

import pandas as pd
import pytest

from dembrane.config import AUDIO_LIGHTRAG_OUTPUT_JSON_FILEPATH
from dembrane.audio_lightrag.main.run_etl import run_etl_pipeline


@pytest.mark.usefixtures("conversation_df", "project_df")
def test_run_etl_pipeline(conversation_df: pd.DataFrame, 
                          project_df: pd.DataFrame,
                          test_audio_uuid: str) -> None:
    # remove the json 
    json_path = AUDIO_LIGHTRAG_OUTPUT_JSON_FILEPATH + '/' + test_audio_uuid + '.json'
    if os.path.exists(json_path):
        os.remove(json_path)
    run_etl_pipeline([
        test_audio_uuid,
    ])
    
