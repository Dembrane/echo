"""free_tier is optional on WorkspaceUsageResponse so pre-deploy cached
payloads (which lack it) still deserialize."""

import os

os.environ.setdefault("DIRECTUS_SECRET", "test-secret")
os.environ.setdefault("DIRECTUS_TOKEN", "test-token")
os.environ.setdefault("DIRECTUS_BASE_URL", "http://localhost:8055")
os.environ.setdefault("DATABASE_URL", "postgresql://u:p@localhost:5432/db")
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

from dembrane.api.v2.workspaces import WorkspaceUsageResponse  # noqa: E402


def _minimal_payload() -> dict:
    return {
        "cycle_start": "2026-06-01T00:00:00Z",
        "cycle_end_exclusive": "2026-07-01T00:00:00Z",
        "tier": "free",
        "tier_tagline": "get started",
        "audio_hours": 0.0,
        "audio_hours_included": 1,
        "seat_count": 1,
        "seat_count_included": 1,
        "member_count": 1,
        "external_count": 0,
        "observer_count": 0,
        "pending_count": 0,
        "project_count": 0,
        "projects": [],
        "pilot_hard_block_active": False,
        "usage_gates": {
            "over_cap_active": False,
            "uploads_locked": False,
            "upgrade_cta_tier": None,
        },
    }


def test_free_tier_defaults_to_none_when_absent():
    resp = WorkspaceUsageResponse(**_minimal_payload())
    assert resp.free_tier is None


def test_free_tier_round_trips_when_present():
    payload = _minimal_payload()
    payload["free_tier"] = {"active": True, "chats_used": 1}
    resp = WorkspaceUsageResponse(**payload)
    assert resp.free_tier == {"active": True, "chats_used": 1}
