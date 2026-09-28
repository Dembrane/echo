"""Dramatiq entry for load tests only: echo main's tasks with Gemini replaced by a fixed
latency, so a run measures the pipeline and not the model provider. The audio is still
fetched from storage and base64-encoded, as the real call does.
  FAKE_TRANSCRIBE_MS (default 8000) plus up to FAKE_TRANSCRIBE_JITTER_MS (default 4000)
Run: PYTHONPATH=<this dir> dramatiq loadtest_fake_tasks
"""

import os
import random
import time

import dembrane.transcribe as transcribe

_BASE = int(os.environ.get("FAKE_TRANSCRIBE_MS", "8000")) / 1000
_JITTER = int(os.environ.get("FAKE_TRANSCRIBE_JITTER_MS", "4000")) / 1000


def _fake_gemini(audio_file_uri, language, hotwords, use_pii_redaction, *args, **kwargs):
    audio = transcribe._get_audio_file_object(audio_file_uri)
    time.sleep(_BASE + random.random() * _JITTER)
    size = len(audio["file"]["file_data"])
    return f"fake transcript of {size} base64 chars", "", "fake"


transcribe._transcribe_audio_gemini = _fake_gemini

from dembrane.tasks import *  # noqa: E402,F401,F403  registers the actors on the broker
