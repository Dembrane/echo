"""Tests for usage_gates exposure in API response models.

Covers:
    - UsageGatesResponse model serialization matches expected shape.
    - UsageGatesSummary model (workspace list) serialization.
    - upgrade_cta_tier is populated from next_tier() for each tier.
    - Integration: compute_usage_gates feeds into UsageGatesResponse correctly
      across the full tier × under/at/over-cap matrix.
    - Guardian (top tier) has upgrade_cta_tier=None.
    - Unknown tier produces safe defaults.
"""

from __future__ import annotations

import pytest

from dembrane.policies import TIER_ORDER
from dembrane.tier_capacity import (
    next_tier,
    compute_usage_gates,
)


class TestUsageGatesResponseShape:
    """Verify the Pydantic model roundtrips with the expected fields."""

    def test_default_gates(self):
        from dembrane.api.v2.workspaces import UsageGatesResponse

        gates = UsageGatesResponse()
        d = gates.model_dump()
        assert d == {
            "over_cap_active": False,
            "uploads_locked": False,
            "upgrade_cta_tier": None,
        }

    def test_active_gates_with_cta(self):
        from dembrane.api.v2.workspaces import UsageGatesResponse

        gates = UsageGatesResponse(
            over_cap_active=True,
            uploads_locked=True,
            upgrade_cta_tier="pilot",
        )
        d = gates.model_dump()
        assert d["over_cap_active"] is True
        assert d["uploads_locked"] is True
        assert d["upgrade_cta_tier"] == "pilot"


class TestUsageGatesSummaryShape:
    """Verify the list-endpoint model mirrors the detail model's shape."""

    def test_default_summary(self):
        from dembrane.api.v2.schemas import UsageGatesSummary

        gates = UsageGatesSummary()
        d = gates.model_dump()
        assert d == {
            "over_cap_active": False,
            "uploads_locked": False,
            "upgrade_cta_tier": None,
        }


class TestUpgradeCtaTier:
    """upgrade_cta_tier should match next_tier() for every known tier."""

    @pytest.mark.parametrize("tier", TIER_ORDER)
    def test_cta_matches_next_tier(self, tier: str):
        expected = next_tier(tier)
        from dembrane.api.v2.workspaces import UsageGatesResponse

        gates_raw = compute_usage_gates(tier, hours_lifetime=0.0, _hours_this_month=0.0)
        response = UsageGatesResponse(
            over_cap_active=gates_raw.over_cap_active,
            uploads_locked=gates_raw.uploads_locked,
            upgrade_cta_tier=next_tier(tier),
        )
        assert response.upgrade_cta_tier == expected

    def test_guardian_has_no_cta(self):
        assert next_tier("guardian") is None

    def test_free_cta_is_pilot(self):
        assert next_tier("free") == "pilot"

    def test_pilot_cta_is_pioneer(self):
        assert next_tier("pilot") == "pioneer"


class TestUsageGatesIntegration:
    """End-to-end: compute_usage_gates + UsageGatesResponse for the full matrix."""

    def _build_response(self, tier: str, hours_lifetime: float, hours_this_month: float):
        from dembrane.api.v2.workspaces import UsageGatesResponse

        gates_raw = compute_usage_gates(tier, hours_lifetime, hours_this_month)
        return UsageGatesResponse(
            over_cap_active=gates_raw.over_cap_active,
            uploads_locked=gates_raw.uploads_locked,
            upgrade_cta_tier=next_tier(tier),
        )

    def test_free_under_cap(self):
        r = self._build_response("free", 0.5, 0.5)
        assert r.over_cap_active is False
        assert r.uploads_locked is False
        assert r.upgrade_cta_tier == "pilot"

    def test_free_at_cap(self):
        r = self._build_response("free", 1.0, 0.5)
        assert r.over_cap_active is True
        assert r.uploads_locked is True
        assert r.upgrade_cta_tier == "pilot"

    def test_free_over_cap(self):
        r = self._build_response("free", 3.0, 0.0)
        assert r.over_cap_active is True
        assert r.uploads_locked is True
        assert r.upgrade_cta_tier == "pilot"

    def test_pilot_under_cap(self):
        r = self._build_response("pilot", 5.0, 5.0)
        assert r.over_cap_active is False
        assert r.uploads_locked is False
        assert r.upgrade_cta_tier == "pioneer"

    def test_pilot_at_cap(self):
        r = self._build_response("pilot", 10.0, 3.0)
        assert r.over_cap_active is True
        assert r.uploads_locked is True
        assert r.upgrade_cta_tier == "pioneer"

    def test_pilot_over_cap(self):
        r = self._build_response("pilot", 15.0, 1.0)
        assert r.over_cap_active is True
        assert r.uploads_locked is True
        assert r.upgrade_cta_tier == "pioneer"

    @pytest.mark.parametrize("tier", ["pioneer", "innovator", "changemaker", "guardian"])
    def test_overage_tier_never_gates(self, tier: str):
        r = self._build_response(tier, 999.0, 999.0)
        assert r.over_cap_active is False
        assert r.uploads_locked is False

    @pytest.mark.parametrize("tier", ["pioneer", "innovator", "changemaker"])
    def test_overage_tier_has_cta(self, tier: str):
        r = self._build_response(tier, 0.0, 0.0)
        assert r.upgrade_cta_tier is not None

    def test_guardian_has_no_cta(self):
        r = self._build_response("guardian", 0.0, 0.0)
        assert r.upgrade_cta_tier is None

    def test_unknown_tier_safe_defaults(self):
        r = self._build_response("nonexistent", 999.0, 999.0)
        assert r.over_cap_active is False
        assert r.uploads_locked is False
        assert r.upgrade_cta_tier is None


class TestWorkspaceUsageResponseIncludesGates:
    """Verify WorkspaceUsageResponse model includes usage_gates field."""

    def test_response_has_gates_field(self):
        from dembrane.api.v2.workspaces import WorkspaceUsageResponse

        fields = WorkspaceUsageResponse.model_fields
        assert "usage_gates" in fields

    def test_response_gates_default(self):
        from dembrane.api.v2.workspaces import UsageGatesResponse, WorkspaceUsageResponse

        resp = WorkspaceUsageResponse(
            cycle_start="2026-05-01T00:00:00Z",
            cycle_end_exclusive="2026-06-01T00:00:00Z",
            tier="free",
            tier_tagline="get started.",
            audio_hours=0.0,
            audio_hours_included=1,
            seat_count=1,
            seat_count_included=1,
            member_count=1,
            external_count=0,
            pending_count=0,
            project_count=0,
            projects=[],
            pilot_hard_block_active=False,
        )
        assert isinstance(resp.usage_gates, UsageGatesResponse)
        assert resp.usage_gates.over_cap_active is False
        assert resp.usage_gates.uploads_locked is False

    def test_response_gates_populated(self):
        from dembrane.api.v2.workspaces import UsageGatesResponse, WorkspaceUsageResponse

        gates = UsageGatesResponse(
            over_cap_active=True,
            uploads_locked=True,
            upgrade_cta_tier="pilot",
        )
        resp = WorkspaceUsageResponse(
            cycle_start="2026-05-01T00:00:00Z",
            cycle_end_exclusive="2026-06-01T00:00:00Z",
            tier="free",
            tier_tagline="get started.",
            audio_hours=1.5,
            audio_hours_included=1,
            seat_count=1,
            seat_count_included=1,
            member_count=1,
            external_count=0,
            pending_count=0,
            project_count=1,
            projects=[],
            pilot_hard_block_active=False,
            usage_gates=gates,
        )
        assert resp.usage_gates.over_cap_active is True
        assert resp.usage_gates.uploads_locked is True
        assert resp.usage_gates.upgrade_cta_tier == "pilot"


class TestWorkspaceUsageSchemaIncludesGates:
    """Verify WorkspaceUsage (list endpoint schema) includes usage_gates."""

    def test_usage_has_gates_field(self):
        from dembrane.api.v2.schemas import WorkspaceUsage

        fields = WorkspaceUsage.model_fields
        assert "usage_gates" in fields

    def test_usage_gates_default(self):
        from dembrane.api.v2.schemas import WorkspaceUsage, UsageGatesSummary

        usage = WorkspaceUsage()
        assert isinstance(usage.usage_gates, UsageGatesSummary)
        assert usage.usage_gates.over_cap_active is False
        assert usage.usage_gates.uploads_locked is False
        assert usage.usage_gates.upgrade_cta_tier is None
