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


def _unsummarized_filter(monkeypatch):
    seen: list[dict] = []

    def _get_items(_collection, query):
        seen.append(query["query"]["filter"])
        return []

    monkeypatch.setattr(cu.directus, "get_items", _get_items)
    assert cu.collect_unsummarized_conversations() == []
    return seen[0]


def test_unsummarized_skips_conversations_locked_on_a_capped_tier(monkeypatch):
    """Mirrors is_conversation_locked: over cap AND a capped tier. Left in the
    oldest-first window, locked rows fill all 50 slots and starve paying
    conversations. The tier is read live (ADR 0001: the stamp is permanent,
    the lock is not), so an upgrade brings them back with no extra hook and
    a missing tier is unlocked, exactly like the gate."""
    from dembrane.tier_capacity import OVERAGE_TIERS

    clauses = _unsummarized_filter(monkeypatch)["_and"]
    over_cap_clause = next(c for c in clauses if any("is_over_cap" in o for o in c["_or"]))
    alts = over_cap_clause["_or"]

    assert {"is_over_cap": {"_eq": False}} in alts
    assert {"is_over_cap": {"_null": True}} in alts
    tier_filters = [
        o["project_id"]["workspace_id"]["billing_account_id"]["tier"]
        for o in alts
        if "project_id" in o
    ]
    assert {"_null": True} in tier_filters
    assert set(next(t["_in"] for t in tier_filters if "_in" in t)) == set(OVERAGE_TIERS)


def test_unsummarized_keeps_chunkless_conversations(monkeypatch):
    """summarize_conversation writes the [No transcript available] sentinel for
    a finished, empty conversation, so chunkless rows must stay in the window."""
    assert "chunks" not in _unsummarized_filter(monkeypatch)


def test_unsummarized_still_requires_missing_summary(monkeypatch):
    clauses = _unsummarized_filter(monkeypatch)["_and"]
    summary_clause = next(c for c in clauses if any("summary" in o for o in c["_or"]))
    assert {"summary": {"_null": True}} in summary_clause["_or"]
    assert {"summary": {"_empty": True}} in summary_clause["_or"]
