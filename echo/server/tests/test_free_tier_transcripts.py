"""Free-tier transcript gating: _enrich_conversation lock reason + summary scrub."""

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


class TestFreeTierLock:
    def test_free_non_oldest_locked_with_reason(self):
        conv = {"id": "c2", "is_over_cap": False, "summary": "secret"}
        out = _enrich_conversation(conv, "free", free_tier_unlocked_id="c1")
        assert out["locked"] is True
        assert out["lock_reason"] == "free_tier"
        assert out["summary"] is None
        assert out["summary_locked"] is True

    def test_free_oldest_unlocked(self):
        conv = {"id": "c1", "is_over_cap": False, "summary": "keep"}
        out = _enrich_conversation(conv, "free", free_tier_unlocked_id="c1")
        assert out["locked"] is False
        assert out.get("lock_reason") is None
        assert out["summary"] == "keep"
        assert out.get("summary_locked") is not True

    def test_hours_cap_reason_when_over_cap(self):
        conv = {"id": "c1", "is_over_cap": True, "summary": "x"}
        # oldest (unlocked) but over hours cap -> still locked, hours_cap reason
        out = _enrich_conversation(conv, "free", free_tier_unlocked_id="c1")
        assert out["locked"] is True
        assert out["lock_reason"] == "hours_cap"
        assert out["summary"] is None

    def test_paid_tier_never_locked(self):
        conv = {"id": "c2", "is_over_cap": False, "summary": "keep"}
        out = _enrich_conversation(conv, "changemaker", free_tier_unlocked_id="c1")
        assert out["locked"] is False
        assert out["summary"] == "keep"

    def test_none_tier_never_locked(self):
        conv = {"id": "c2", "is_over_cap": False, "summary": "keep"}
        out = _enrich_conversation(conv, None, free_tier_unlocked_id="c1")
        assert out["locked"] is False
        assert out["summary"] == "keep"

    def test_no_unlocked_id_falls_back_to_hours_only(self):
        # free tier, no unlocked id passed (legacy callers): behave like hours-cap only
        conv = {"id": "c1", "is_over_cap": False, "summary": "keep"}
        out = _enrich_conversation(conv, "free")
        assert out["locked"] is False
        assert out["summary"] == "keep"

    def test_merged_transcript_scrubbed_when_locked(self):
        conv = {
            "id": "c2",
            "is_over_cap": False,
            "summary": "s",
            "merged_transcript": "full transcript text",
        }
        out = _enrich_conversation(conv, "free", free_tier_unlocked_id="c1")
        assert out["merged_transcript"] is None

    def test_merged_transcript_kept_when_unlocked(self):
        conv = {
            "id": "c1",
            "is_over_cap": False,
            "summary": "s",
            "merged_transcript": "full transcript text",
        }
        out = _enrich_conversation(conv, "free", free_tier_unlocked_id="c1")
        assert out["merged_transcript"] == "full transcript text"

    def test_merged_transcript_key_not_added_when_absent(self):
        # lean list rows without merged_transcript shouldn't gain a null key
        conv = {"id": "c2", "is_over_cap": False, "summary": "s"}
        out = _enrich_conversation(conv, "free", free_tier_unlocked_id="c1")
        assert "merged_transcript" not in out

    def test_embedded_chunk_transcripts_scrubbed_when_locked(self):
        # `fields=chunks.transcript` embeds chunks inline; they must be scrubbed.
        conv = {
            "id": "c2",
            "is_over_cap": False,
            "summary": "s",
            "chunks": [
                {"id": "ch1", "transcript": "secret one"},
                {"id": "ch2", "transcript": "secret two"},
            ],
        }
        out = _enrich_conversation(conv, "free", free_tier_unlocked_id="c1")
        assert all(c["transcript"] is None for c in out["chunks"])
        assert all(c["transcript_locked"] is True for c in out["chunks"])

    def test_embedded_segment_transcripts_scrubbed_when_locked(self):
        conv = {
            "id": "c2",
            "is_over_cap": False,
            "summary": "s",
            "conversation_segments": [
                {"id": "s1", "transcript": "seg", "contextual_transcript": "ctx"},
            ],
        }
        out = _enrich_conversation(conv, "free", free_tier_unlocked_id="c1")
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
        out = _enrich_conversation(conv, "free", free_tier_unlocked_id="c1")
        assert out["chunks"][0]["transcript"] == "visible"


class TestConversationLockHelper:
    def test_hours_cap_precedence(self):
        locked, reason = _conversation_lock(
            {"id": "c1", "is_over_cap": True}, "free", free_tier_unlocked_id="c1"
        )
        assert (locked, reason) == (True, "hours_cap")

    def test_free_tier_reason(self):
        locked, reason = _conversation_lock(
            {"id": "c2", "is_over_cap": False}, "free", free_tier_unlocked_id="c1"
        )
        assert (locked, reason) == (True, "free_tier")

    def test_unlocked(self):
        locked, reason = _conversation_lock(
            {"id": "c1", "is_over_cap": False}, "free", free_tier_unlocked_id="c1"
        )
        assert (locked, reason) == (False, None)

    def test_paid_never_locked(self):
        locked, reason = _conversation_lock(
            {"id": "c2", "is_over_cap": False}, "changemaker", free_tier_unlocked_id="c1"
        )
        assert (locked, reason) == (False, None)
