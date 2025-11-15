import os
import logging

import pytest

from dembrane.s3 import delete_from_s3, save_to_s3_from_url
from dembrane.utils import get_utc_timestamp
from dembrane.directus import directus
from dembrane.transcribe import transcribe_audio_assemblyai, transcribe_conversation_chunk

logger = logging.getLogger("test_transcribe_assembly")

pytestmark = pytest.mark.integration


def _require_assemblyai():
    """Ensure AssemblyAI is enabled and credentials are present or skip."""
    if not os.environ.get("ASSEMBLYAI_API_KEY"):
        pytest.skip("ASSEMBLYAI_API_KEY not set; skipping AssemblyAI tests")
    # Force provider selection to AssemblyAI in config by env flags
    os.environ["ENABLE_ASSEMBLYAI_TRANSCRIPTION"] = "true"
    os.environ["ENABLE_RUNPOD_WHISPER_TRANSCRIPTION"] = "false"
    os.environ["ENABLE_LITELLM_WHISPER_TRANSCRIPTION"] = "false"


@pytest.fixture
def fixture_chunk_en():
    _require_assemblyai()
    logger.info("setup")

    p = directus.create_item(
        "project",
        {
            "name": "test",
            "language": "en",
            "is_conversation_allowed": True,
        },
    )["data"]

    c = directus.create_item(
        "conversation",
        {"project_id": p["id"], "participant_name": "test_assembly_en", "language": "en"},
    )["data"]

    path = save_to_s3_from_url(
        "https://github.com/runpod-workers/sample-inputs/raw/refs/heads/main/audio/Arthur.mp3",
        public=True,
    )

    cc = directus.create_item(
        "conversation_chunk",
        {
            "conversation_id": c["id"],
            "path": path,
            "timestamp": str(get_utc_timestamp()),
        },
    )["data"]

    yield {
        "project_id": p["id"],
        "conversation_id": c["id"],
        "chunk_id": cc["id"],
        "path": path,
    }

    logger.info("teardown")
    directus.delete_item("conversation_chunk", cc["id"])
    directus.delete_item("conversation", c["id"])
    directus.delete_item("project", p["id"])
    delete_from_s3(path)


@pytest.fixture
def fixture_chunk_nl():
    _require_assemblyai()
    logger.info("setup")

    p = directus.create_item(
        "project",
        {
            "name": "test",
            "language": "nl",
            "is_conversation_allowed": True,
        },
    )["data"]

    c = directus.create_item(
        "conversation",
        {"project_id": p["id"], "participant_name": "test_assembly_nl", "language": "nl"},
    )["data"]

    path = save_to_s3_from_url(
        "https://github.com/runpod-workers/sample-inputs/raw/refs/heads/main/audio/Arthur.mp3",
        public=True,
    )

    cc = directus.create_item(
        "conversation_chunk",
        {
            "conversation_id": c["id"],
            "path": path,
            "timestamp": str(get_utc_timestamp()),
        },
    )["data"]

    yield {
        "project_id": p["id"],
        "conversation_id": c["id"],
        "chunk_id": cc["id"],
        "path": path,
    }

    logger.info("teardown")
    directus.delete_item("conversation_chunk", cc["id"])
    directus.delete_item("conversation", c["id"])
    directus.delete_item("project", p["id"])
    delete_from_s3(path)


class TestTranscribeAssemblyAI:
    def test_transcribe_conversation_chunk_en(self, fixture_chunk_en):
        chunk_id = fixture_chunk_en["chunk_id"]
        result_id = transcribe_conversation_chunk(chunk_id)
        assert result_id == chunk_id

        # fetch chunk and validate transcript saved (API is synchronous)
        cc = dict(directus.get_item("conversation_chunk", result_id))
        assert cc.get("transcript") is not None
        assert isinstance(cc.get("transcript"), str)
        assert len(cc.get("transcript")) > 0

    def test_transcribe_conversation_chunk_nl(self, fixture_chunk_nl):
        chunk_id = fixture_chunk_nl["chunk_id"]
        result_id = transcribe_conversation_chunk(chunk_id)
        assert result_id == chunk_id

        cc = dict(directus.get_item("conversation_chunk", result_id))
        assert cc.get("transcript") is not None
        assert isinstance(cc.get("transcript"), str)
        assert len(cc.get("transcript")) > 0


def test_transcribe_audio_assemblyai():
    transcript, response = transcribe_audio_assemblyai(
        audio_file_uri="https://github.com/runpod-workers/sample-inputs/raw/refs/heads/main/audio/Arthur.mp3",
        language="en",
        hotwords=["Arther"],
    )

    assert transcript is not None
    assert response is not None
    assert response.get("words") is not None
    assert response.get("words") is not None
