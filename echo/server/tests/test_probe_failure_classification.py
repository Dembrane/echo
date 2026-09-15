"""probe_from_bytes classifies ffprobe failures at the process boundary.

Only diagnostics that name the bytes as the problem become InvalidAudioError,
which the chunk actor treats as terminal. A process killed by a signal (memory
pressure during a rolling deploy) or an unrecognised message stays a plain
FFmpegError so dramatiq retries it.
"""

from __future__ import annotations

import subprocess
from types import SimpleNamespace

import pytest

import dembrane.audio_utils as audio_utils


def _ffprobe(monkeypatch, returncode: int, stderr: bytes):
    def _run(*_a, **_k):
        return SimpleNamespace(returncode=returncode, stdout=b"", stderr=stderr)

    monkeypatch.setattr(subprocess, "run", _run)


@pytest.mark.parametrize(
    "stderr",
    [
        b"[mp3 @ 0x7f] Failed to find two consecutive MPEG audio frames.",
        b"[mov @ 0x7f] moov atom not found",
        b"garbage: Invalid data found when processing input",
    ],
)
def test_invalid_input_diagnostics_are_terminal(monkeypatch, stderr):
    _ffprobe(monkeypatch, 1, stderr)
    with pytest.raises(audio_utils.InvalidAudioError):
        audio_utils.probe_from_bytes(b"not audio", "mp3")


def test_killed_ffprobe_is_retryable(monkeypatch):
    _ffprobe(monkeypatch, -9, b"")
    with pytest.raises(audio_utils.FFmpegError) as excinfo:
        audio_utils.probe_from_bytes(b"fine audio, unlucky worker", "mp3")
    assert not isinstance(excinfo.value, audio_utils.InvalidAudioError)
    assert "signal 9" in str(excinfo.value)


def test_unrecognised_ffprobe_failure_is_retryable(monkeypatch):
    _ffprobe(monkeypatch, 1, b"Cannot allocate memory")
    with pytest.raises(audio_utils.FFmpegError) as excinfo:
        audio_utils.probe_from_bytes(b"fine audio", "mp3")
    assert not isinstance(excinfo.value, audio_utils.InvalidAudioError)
