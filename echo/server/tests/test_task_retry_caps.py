"""Pipeline actors declare their retry policy explicitly instead of inheriting
dramatiq's default, so a change shows up in the diff. Confirmed bad input is
handled by terminal classification, not by a low cap: valid work keeps its
full recovery window during an outage."""

from __future__ import annotations

import pytest

import dembrane.tasks as tasks


@pytest.mark.parametrize(
    "actor",
    [
        tasks.task_process_conversation_chunk,
        tasks.task_merge_conversation_chunks,
        tasks.task_summarize_conversation,
        tasks.task_finalize_conversation,
        tasks.task_finish_conversation_hook,
        tasks.task_transcribe_chunk,
    ],
)
def test_pipeline_actor_declares_its_retry_policy(actor):
    assert "max_retries" in actor.options


@pytest.mark.parametrize(
    "actor",
    [
        tasks.task_process_conversation_chunk,
        tasks.task_merge_conversation_chunks,
        tasks.task_summarize_conversation,
        tasks.task_finalize_conversation,
        tasks.task_finish_conversation_hook,
    ],
)
def test_pipeline_actor_keeps_the_full_recovery_window(actor):
    assert actor.options["max_retries"] == 20
