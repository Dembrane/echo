import time
import logging

import pytest

from dembrane.s3 import delete_from_s3, save_to_s3_from_url
from dembrane.utils import get_utc_timestamp
from dembrane.directus import directus
from dembrane.transcribe import (
	_get_status_runpod,
	queue_transcribe_audio_runpod,
	transcribe_conversation_chunk,
)

logger = logging.getLogger("test_transcribe")

# Runpod is no longer used in the platform; keep tests for reference but skip them.
pytestmark = pytest.mark.skip(reason="Runpod transcription is deprecated and no longer used")

@pytest.fixture
def fixture_english_chunk():
	logger.info("setup")

	p = directus.create_item("project", {
		"name": "test",
		"language": "en",
		"is_conversation_allowed": True,
	})["data"]

	c = directus.create_item("conversation", {
		"project_id": p["id"],
		"participant_name": "test_english",
		"language": "en"
	})["data"]

	path = save_to_s3_from_url("https://github.com/runpod-workers/sample-inputs/raw/refs/heads/main/audio/Arthur.mp3", public=True)

	cc = directus.create_item("conversation_chunk", {
		"conversation_id": c["id"],
		"path": path,
		"timestamp": str(get_utc_timestamp()),
	})["data"]

	yield cc["id"]

	logger.info("teardown")

	directus.delete_item("conversation_chunk", cc["id"])

	directus.delete_item("conversation", c["id"])

	directus.delete_item("project", p["id"])

	delete_from_s3(path)

@pytest.fixture
def fixture_dutch_chunk():
	logger.info("setup")

	p = directus.create_item("project", {
		"name": "test",
		"language": "nl",
		"is_conversation_allowed": True,
	})["data"]

	c = directus.create_item("conversation", {
		"project_id": p["id"],
		"participant_name": "test_dutch",
		"language": "nl"
	})["data"]

	path = save_to_s3_from_url("https://github.com/runpod-workers/sample-inputs/raw/refs/heads/main/audio/Arthur.mp3", public=True)

	cc = directus.create_item("conversation_chunk", {
		"conversation_id": c["id"],
		"path": path,
		"timestamp": str(get_utc_timestamp()),
	})["data"]

	yield cc["id"]

	logger.info("teardown")

	directus.delete_item("conversation_chunk", cc["id"])

	directus.delete_item("conversation", c["id"])

	directus.delete_item("project", p["id"])

	delete_from_s3(path)


@pytest.mark.parametrize("is_priority", [True, False])
def test_queue_transcribe_audio_runpod(is_priority: bool):
	job_id = queue_transcribe_audio_runpod(
		audio_file_uri="https://github.com/runpod-workers/sample-inputs/raw/refs/heads/main/audio/Arthur.mp3",
		whisper_prompt="",
		language="en",
		is_priority=is_priority,
	)
	assert job_id is not None


def test_transcribe_conversation_chunk_english(fixture_english_chunk):
	logger.info(f"fixture_english_chunk conversation_chunk_id: {fixture_english_chunk}")
	result = transcribe_conversation_chunk(fixture_english_chunk)
	logger.info(f"result: {result}")
	assert result is not None


def test_transcribe_conversation_chunk_dutch(fixture_dutch_chunk):
	logger.info(f"fixture_dutch_chunk: {fixture_dutch_chunk}")
	result = transcribe_conversation_chunk(fixture_dutch_chunk)

	# get the conversation chunk
	cc = dict(directus.get_item("conversation_chunk", result))

	logger.info(f"cc: {cc}")
	assert cc.get("runpod_job_status_link") is not None

	status, _ = _get_status_runpod(cc["runpod_job_status_link"])
	while status in ["IN_PROGRESS", "IN_QUEUE"]:
		logger.info(f"waiting for job to finish: {status}")
		time.sleep(2)
		status, _ = _get_status_runpod(cc["runpod_job_status_link"])
	
	# get the status of the job
	status, data = _get_status_runpod(cc["runpod_job_status_link"])

	logger.info(f"data: {data}")

	# get the output
	assert data.get("output") is not None
	assert data.get("output").get("joined_text") is not None
	
	





