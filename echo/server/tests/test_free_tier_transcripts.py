"""Free-tier transcript gating: _enrich_conversation lock reason + summary scrub.

Transcripts gate on the 1-hour recording cap (is_over_cap), not a conversation
count. A free workspace sees every conversation recorded under the cap; only
over-cap conversations lock. Paid and legacy (None) tiers never lock.
"""

import os

os.environ.setdefault("DIRECTUS_SECRET", "t")
os.environ.setdefault("DIRECTUS_TOKEN", "t")
os.environ.setdefault("DIRECTUS_BASE_URL", "http://l")
os.environ.setdefault("DATABASE_URL", "postgresql://u:p@l:5432/d")
os.environ.setdefault("REDIS_URL", "redis://l:6379/0")

from dembrane.api.v2.bff.conversations import (  # noqa: E402
    _conversation_lock,
    _enrich_conversation,
)


class TestHoursCapLock:
    def test_free_over_cap_locked_with_reason(self):
        conv = {"id": "c2", "is_over_cap": True, "summary": "secret"}
        out = _enrich_conversation(conv, "free")
        assert out["locked"] is True
        assert out["lock_reason"] == "hours_cap"
        assert out["summary"] is None
        assert out["summary_locked"] is True

    def test_free_under_cap_unlocked(self):
        conv = {"id": "c1", "is_over_cap": False, "summary": "keep"}
        out = _enrich_conversation(conv, "free")
        assert out["locked"] is False
        assert out.get("lock_reason") is None
        assert out["summary"] == "keep"
        assert out.get("summary_locked") is not True

    def test_paid_tier_never_locked(self):
        conv = {"id": "c2", "is_over_cap": True, "summary": "keep"}
        out = _enrich_conversation(conv, "changemaker")
        assert out["locked"] is False
        assert out["summary"] == "keep"

    def test_none_tier_never_locked(self):
        conv = {"id": "c2", "is_over_cap": True, "summary": "keep"}
        out = _enrich_conversation(conv, None)
        assert out["locked"] is False
        assert out["summary"] == "keep"

    def test_merged_transcript_scrubbed_when_locked(self):
        conv = {
            "id": "c2",
            "is_over_cap": True,
            "summary": "s",
            "merged_transcript": "full transcript text",
        }
        out = _enrich_conversation(conv, "free")
        assert out["merged_transcript"] is None

    def test_merged_transcript_kept_when_unlocked(self):
        conv = {
            "id": "c1",
            "is_over_cap": False,
            "summary": "s",
            "merged_transcript": "full transcript text",
        }
        out = _enrich_conversation(conv, "free")
        assert out["merged_transcript"] == "full transcript text"

    def test_merged_transcript_key_not_added_when_absent(self):
        # lean list rows without merged_transcript shouldn't gain a null key
        conv = {"id": "c2", "is_over_cap": True, "summary": "s"}
        out = _enrich_conversation(conv, "free")
        assert "merged_transcript" not in out

    def test_embedded_chunk_transcripts_scrubbed_when_locked(self):
        # `fields=chunks.transcript` embeds chunks inline; they must be scrubbed.
        conv = {
            "id": "c2",
            "is_over_cap": True,
            "summary": "s",
            "chunks": [
                {"id": "ch1", "transcript": "secret one"},
                {"id": "ch2", "transcript": "secret two"},
            ],
        }
        out = _enrich_conversation(conv, "free")
        assert all(c["transcript"] is None for c in out["chunks"])
        assert all(c["transcript_locked"] is True for c in out["chunks"])

    def test_embedded_segment_transcripts_scrubbed_when_locked(self):
        conv = {
            "id": "c2",
            "is_over_cap": True,
            "summary": "s",
            "conversation_segments": [
                {"id": "s1", "transcript": "seg", "contextual_transcript": "ctx"},
            ],
        }
        out = _enrich_conversation(conv, "free")
        seg = out["conversation_segments"][0]
        assert seg["transcript"] is None
        assert seg["contextual_transcript"] is None

    def test_embedded_transcripts_kept_when_unlocked(self):
        conv = {
            "id": "c1",
            "is_over_cap": False,
            "summary": "keep",
            "chunks": [{"id": "ch1", "transcript": "visible"}],
        }
        out = _enrich_conversation(conv, "free")
        assert out["chunks"][0]["transcript"] == "visible"


class TestConversationLockHelper:
    def test_over_cap_locked(self):
        locked, reason = _conversation_lock({"id": "c1", "is_over_cap": True}, "free")
        assert (locked, reason) == (True, "hours_cap")

    def test_under_cap_unlocked(self):
        locked, reason = _conversation_lock({"id": "c1", "is_over_cap": False}, "free")
        assert (locked, reason) == (False, None)

    def test_paid_never_locked(self):
        locked, reason = _conversation_lock(
            {"id": "c2", "is_over_cap": True}, "changemaker"
        )
        assert (locked, reason) == (False, None)


class TestLiveOverCapGate:
    """The live workspace over-cap gate locks conversations that are still
    recording (no is_over_cap stamp yet) on an over-cap free workspace, while
    leaving finished conversations to the stamp (so grandfathering holds)."""

    def test_live_unstamped_conversation_locked_when_over_cap_active(self):
        conv = {"id": "c1", "is_over_cap": False, "is_finished": False}
        locked, reason = _conversation_lock(conv, "free", over_cap_active=True)
        assert (locked, reason) == (True, "hours_cap")

    def test_finished_grandfathered_conversation_not_locked_by_live_gate(self):
        # Finished, started under cap (is_over_cap False) -> the live gate must
        # not lock it; the stamp is the sole authority for finished ones.
        conv = {"id": "c1", "is_over_cap": False, "is_finished": True}
        locked, reason = _conversation_lock(conv, "free", over_cap_active=True)
        assert (locked, reason) == (False, None)

    def test_live_gate_not_applied_when_workspace_under_cap(self):
        conv = {"id": "c1", "is_over_cap": False, "is_finished": False}
        locked, reason = _conversation_lock(conv, "free", over_cap_active=False)
        assert (locked, reason) == (False, None)

    def test_live_gate_scrubs_summary_and_transcript(self):
        conv = {
            "id": "c1",
            "is_over_cap": False,
            "is_finished": False,
            "summary": "secret",
            "merged_transcript": "full text",
        }
        out = _enrich_conversation(conv, "free", over_cap_active=True)
        assert out["locked"] is True
        assert out["summary"] is None
        assert out["summary_locked"] is True
        assert out["merged_transcript"] is None
