import os
import logging
import importlib
from typing import Any, Callable, Optional

import pytest

from dembrane.s3 import delete_from_s3, save_to_s3_from_url
from dembrane.utils import get_utc_timestamp
from dembrane.directus import directus

TEST_AUDIO_URL = "https://storage.googleapis.com/aai-platform-public/samples/1765269382848385.wav"

transcribe_audio_assemblyai: Optional[Callable[..., tuple[str, dict[str, Any]]]] = None
transcribe_conversation_chunk: Optional[Callable[[str], str]] = None

logger = logging.getLogger("test_transcribe_assembly")


@pytest.fixture(scope="module", autouse=True)
def configure_transcription_provider() -> None:
    """Ensure AssemblyAI is the active transcription provider before tests run."""
    global transcribe_audio_assemblyai
    global transcribe_conversation_chunk

    os.environ.setdefault("TRANSCRIPTION_PROVIDER", "AssemblyAI")

    import dembrane.transcribe as transcribe_module

    importlib.reload(transcribe_module)

    transcribe_audio_assemblyai = transcribe_module.transcribe_audio_assemblyai
    transcribe_conversation_chunk = transcribe_module.transcribe_conversation_chunk
    yield


def _require_assemblyai():
    """Ensure AssemblyAI is enabled and credentials are present or skip."""
    if not os.environ.get("ASSEMBLYAI_API_KEY"):
        pytest.skip("ASSEMBLYAI_API_KEY not set; skipping AssemblyAI tests")
    os.environ["TRANSCRIPTION_PROVIDER"] = "AssemblyAI"
    if transcribe_audio_assemblyai is None or transcribe_conversation_chunk is None:
        pytest.skip("AssemblyAI transcription helpers not initialized")


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

    path = save_to_s3_from_url(TEST_AUDIO_URL, public=True)

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

    path = save_to_s3_from_url(TEST_AUDIO_URL, public=True)

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
        assert transcribe_conversation_chunk is not None
        result_id = transcribe_conversation_chunk(chunk_id)
        assert result_id == chunk_id

        # fetch chunk and validate transcript saved (API is synchronous)
        cc = dict(directus.get_item("conversation_chunk", result_id))
        assert cc.get("transcript") is not None
        assert isinstance(cc.get("transcript"), str)
        assert len(cc.get("transcript")) > 0

    def test_transcribe_conversation_chunk_nl(self, fixture_chunk_nl):
        chunk_id = fixture_chunk_nl["chunk_id"]
        assert transcribe_conversation_chunk is not None
        result_id = transcribe_conversation_chunk(chunk_id)
        assert result_id == chunk_id

        cc = dict(directus.get_item("conversation_chunk", result_id))
        assert cc.get("transcript") is not None
        assert isinstance(cc.get("transcript"), str)
        assert len(cc.get("transcript")) > 0


def test_transcribe_audio_assemblyai():
    assert transcribe_audio_assemblyai is not None
    transcript, response = transcribe_audio_assemblyai(
        audio_file_uri=TEST_AUDIO_URL,
        language="en",
        hotwords=["Arther"],
    )

    assert transcript is not None
    assert response is not None
    assert response.get("words") is not None
    assert response.get("words") is not None
