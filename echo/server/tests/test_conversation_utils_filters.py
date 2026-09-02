"""The catch-up collectors must skip conversations whose project is
soft-deleted: dispatching them makes task_summarize_conversation raise
ProjectNotFoundException every scheduler tick, forever."""

from __future__ import annotations

import pytest

import dembrane.conversation_utils as cu


@pytest.mark.parametrize(
    "collector",
    [
        cu.collect_unfinished_conversations,
        cu.collect_conversations_needing_transcribed_flag,
        cu.collect_unsummarized_conversations,
    ],
)
def test_collectors_exclude_deleted_projects(monkeypatch, collector):
    seen: list[dict] = []

    def _get_items(_collection, query):
        seen.append(query["query"]["filter"])
        return []

    monkeypatch.setattr(cu.directus, "get_items", _get_items)

    assert collector() == []
    assert seen and seen[0]["project_id"] == {"deleted_at": {"_null": True}}
