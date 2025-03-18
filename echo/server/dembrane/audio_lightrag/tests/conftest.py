import os

import pandas as pd
import pytest
from directus_sdk_py import DirectusClient

from dembrane.config import BASE_DIR, DIRECTUS_TOKEN, DIRECTUS_BASE_URL


@pytest.fixture
def conversation_df() -> pd.DataFrame:
    df = pd.read_csv(os.path.join(BASE_DIR, "dembrane/audio_lightrag/tests/data/test_conversation_df.csv"))
    return df

@pytest.fixture
def project_df() -> pd.DataFrame:
    df = pd.read_csv(os.path.join(BASE_DIR, "dembrane/audio_lightrag/tests/data/test_project_df.csv"))
    return df.set_index('id')

@pytest.fixture
def test_audio_uuid() -> str:
    """Fixture providing a test UUID for audio files."""
    conversation_request = {"query": 
                                     {"fields": ["id", "project_id", 
                                                 "chunks.id", "chunks.path", 
                                                 "chunks.timestamp"], 
                                           "limit": 100000,
                                           "deep": {"chunks": 
                                                    {"_limit": 100000, "_sort": "timestamp"}
                                                    }
                                                }
                                    }
    directus_client = DirectusClient(DIRECTUS_BASE_URL, DIRECTUS_TOKEN)
    conversation = directus_client.get_items("conversation", conversation_request)
    return conversation[0]['id']