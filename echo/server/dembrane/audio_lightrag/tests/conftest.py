import pytest
import pandas as pd

@pytest.fixture
def conversation_df():
    df = pd.read_csv('dembrane/audio_lightrag/tests/data/test_conversation_df.csv')
    return df

@pytest.fixture
def project_df():
    df = pd.read_csv('dembrane/audio_lightrag/tests/data/test_project_df.csv')
    return df.set_index('id')
