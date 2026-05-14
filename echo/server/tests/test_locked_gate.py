"""Tests for the live `locked` gate and transcript scrubbing (slice 05).

Covers:
- is_conversation_locked() for every tier × is_over_cap combination
- _enrich_conversation() strips is_over_cap and adds locked
- _scrub_chunk_transcript() redacts transcript and flags transcript_locked
- Upgrade/downgrade scenarios (ADR 0001)
"""

import pytest

from dembrane.tier_capacity import is_conversation_locked
from dembrane.api.v2.bff.conversations import (
    _enrich_conversation,
    _scrub_chunk_transcript,
)

# ── is_conversation_locked ───────────────────────────────────────────

TIERS_OVERAGE = ["pioneer", "innovator", "changemaker", "guardian"]
TIERS_NO_OVERAGE = ["free", "pilot"]
ALL_TIERS = TIERS_NO_OVERAGE + TIERS_OVERAGE


class TestIsConversationLocked:
    """locked = is_over_cap AND NOT tier_allows_overage(current_tier)."""

    @pytest.mark.parametrize("tier", ALL_TIERS)
    def test_not_over_cap_never_locked(self, tier: str) -> None:
        conv = {"is_over_cap": False}
        assert is_conversation_locked(conv, tier) is False

    @pytest.mark.parametrize("tier", TIERS_NO_OVERAGE)
    def test_over_cap_on_non_overage_tier_is_locked(self, tier: str) -> None:
        conv = {"is_over_cap": True}
        assert is_conversation_locked(conv, tier) is True

    @pytest.mark.parametrize("tier", TIERS_OVERAGE)
    def test_over_cap_on_overage_tier_is_not_locked(self, tier: str) -> None:
        conv = {"is_over_cap": True}
        assert is_conversation_locked(conv, tier) is False

    def test_none_tier_never_locked(self) -> None:
        conv = {"is_over_cap": True}
        assert is_conversation_locked(conv, None) is False

    def test_missing_is_over_cap_field_never_locked(self) -> None:
        conv: dict = {}
        assert is_conversation_locked(conv, "free") is False

    def test_is_over_cap_none_never_locked(self) -> None:
        conv = {"is_over_cap": None}
        assert is_conversation_locked(conv, "free") is False


class TestUpgradeDowngradeScenarios:
    """ADR 0001: live gate unlocks on upgrade, re-locks on downgrade."""

    def test_free_to_innovator_unlocks(self) -> None:
        conv = {"is_over_cap": True}
        assert is_conversation_locked(conv, "free") is True
        assert is_conversation_locked(conv, "innovator") is False

    def test_pilot_to_free_keeps_unlocked_when_not_stamped(self) -> None:
        """Pilot content stamped is_over_cap=False stays unlocked on free."""
        conv = {"is_over_cap": False}
        assert is_conversation_locked(conv, "pilot") is False
        assert is_conversation_locked(conv, "free") is False

    def test_over_cap_flag_locks_on_non_overage_tier(self) -> None:
        """The live-lock formula locks when is_over_cap=True and the tier
        doesn't allow overage. In practice, apply_downgrade_effects()
        clears is_over_cap on all conversations during downgrade so
        pre-downgrade content stays readable."""
        conv_stamped = {"is_over_cap": True}
        assert is_conversation_locked(conv_stamped, "pioneer") is False
        assert is_conversation_locked(conv_stamped, "free") is True


# ── _enrich_conversation ──────────────────────────────────────────────


class TestEnrichConversation:
    def test_adds_locked_field(self) -> None:
        conv = {"id": "c1", "is_over_cap": True, "title": "Test"}
        result = _enrich_conversation(conv, "free")
        assert result["locked"] is True

    def test_strips_is_over_cap(self) -> None:
        conv = {"id": "c1", "is_over_cap": False, "title": "Test"}
        result = _enrich_conversation(conv, "free")
        assert "is_over_cap" not in result

    def test_locked_false_for_unlocked_conv(self) -> None:
        conv = {"id": "c1", "is_over_cap": False}
        result = _enrich_conversation(conv, "free")
        assert result["locked"] is False

    def test_locked_false_when_tier_allows_overage(self) -> None:
        conv = {"id": "c1", "is_over_cap": True}
        result = _enrich_conversation(conv, "pioneer")
        assert result["locked"] is False
        assert "is_over_cap" not in result


# ── _scrub_chunk_transcript ───────────────────────────────────────────


class TestScrubChunkTranscript:
    def test_nullifies_transcript(self) -> None:
        chunk = {"id": "ch1", "transcript": "Hello world", "path": "/audio.wav"}
        result = _scrub_chunk_transcript(chunk)
        assert result["transcript"] is None

    def test_adds_transcript_locked_flag(self) -> None:
        chunk = {"id": "ch1", "transcript": "Hello world"}
        result = _scrub_chunk_transcript(chunk)
        assert result["transcript_locked"] is True

    def test_preserves_audio_fields(self) -> None:
        chunk = {
            "id": "ch1",
            "transcript": "Hello",
            "path": "/audio.wav",
            "source": "PORTAL_AUDIO",
            "timestamp": "2026-01-01T00:00:00Z",
        }
        result = _scrub_chunk_transcript(chunk)
        assert result["path"] == "/audio.wav"
        assert result["source"] == "PORTAL_AUDIO"
        assert result["timestamp"] == "2026-01-01T00:00:00Z"

    def test_already_null_transcript(self) -> None:
        chunk = {"id": "ch1", "transcript": None}
        result = _scrub_chunk_transcript(chunk)
        assert result["transcript"] is None
        assert result["transcript_locked"] is True
