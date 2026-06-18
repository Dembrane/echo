"""Tests for ISSUE-025: pivot the staff rollup onto the billing account.

Covers:
- account aggregation: an org-scoped account pools N workspaces' seats and
  workspace counts; a workspace-scoped account = exactly one workspace.
- trial accounts (type_discount="trial", or the comped reverse-trial shape) add
  €0 to total_forecast_eur / MRR and are flagged is_trial.
- managed accounts (payment_mode="offline") are flagged is_managed and DO count
  toward revenue (offline-invoiced).
- granting a trial never raises the paying-revenue total.
- payment_mode / label join into _all_active_workspaces.

async_directus is mocked throughout; no live Directus.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from dembrane.api.dependency_auth import DirectusSession


def _auth(is_admin: bool = True) -> DirectusSession:
    return DirectusSession(user_id="staff-1", is_admin=is_admin)


# ── _all_active_workspaces flattens payment_mode + label ──


@pytest.mark.asyncio
@patch("dembrane.api.v2.admin.async_directus")
async def test_all_active_workspaces_flattens_payment_mode_and_label(mock_directus):
    from dembrane.api.v2.admin import _all_active_workspaces

    mock_directus.get_items = AsyncMock(
        return_value=[
            {
                "id": "ws-1",
                "name": "WS One",
                "org_id": "org-1",
                "billing_account_id": {
                    "id": "acc-1",
                    "tier": "changemaker",
                    "org_id": "org-1",
                    "workspace_id": None,
                    "payment_mode": "offline",
                    "label": "Acme billing",
                },
                "billed_to_team_id": None,
                "effective_client_team_id": None,
            }
        ]
    )

    ws = (await _all_active_workspaces())[0]
    assert ws["account_payment_mode"] == "offline"
    assert ws["account_label"] == "Acme billing"
    assert ws["account_scope"] == "organisation"


# ── account aggregation helper ──


def _ws_row(
    *,
    workspace_id: str,
    account_id: str,
    scope: str = "organisation",
    tier: str = "changemaker",
    seats: int = 0,
    externals: int = 0,
    is_active: bool = True,
    type_discount=None,
    tier_expires_at=None,
    percent_discount=None,
):
    from dembrane.api.v2.admin import BillingRow

    return BillingRow(
        workspace_id=workspace_id,
        workspace_name=f"name-{workspace_id}",
        org_id="org-1",
        org_name="Acme",
        billing_account_id=account_id,
        account_scope=scope,
        tier=tier,
        audio_hours=0.0,
        seat_count=seats,
        external_count=externals,
        is_active=is_active,
        type_discount=type_discount,
        tier_expires_at=tier_expires_at,
        percent_discount=percent_discount,
    )


def test_org_account_pools_workspaces():
    from dembrane.api.v2.admin import _aggregate_accounts

    rows = [
        _ws_row(workspace_id="ws-1", account_id="acc-org", seats=3, externals=1),
        _ws_row(
            workspace_id="ws-2",
            account_id="acc-org",
            seats=2,
            externals=0,
            is_active=False,
        ),
    ]
    accounts = _aggregate_accounts(
        rows,
        org_name_by_id={"org-1": "Acme"},
        label_by_account={"acc-org": "Acme billing"},
        payment_mode_by_account={"acc-org": "mollie"},
        now_iso="2026-06-18T00:00:00+00:00",
    )
    assert len(accounts) == 1
    acc = accounts[0]
    assert acc.workspace_count == 2
    assert acc.active_workspace_count == 1
    # Pooled seats: 3+2 members, 1+0 external.
    assert acc.seat_count == 5
    assert acc.external_count == 1
    assert acc.label == "Acme billing"
    assert acc.account_scope == "organisation"
    # Paying (mollie) Changemaker account: base charged once, not per workspace.
    assert acc.total_forecast_eur == 1500.0
    assert acc.is_comped is False


def test_workspace_account_is_single_workspace():
    from dembrane.api.v2.admin import _aggregate_accounts

    rows = [
        _ws_row(
            workspace_id="ws-self",
            account_id="acc-self",
            scope="workspace",
            tier="innovator",
            seats=4,
        )
    ]
    accounts = _aggregate_accounts(
        rows,
        org_name_by_id={"org-1": "Acme"},
        label_by_account={"acc-self": None},
        payment_mode_by_account={"acc-self": "mollie"},
        now_iso="2026-06-18T00:00:00+00:00",
    )
    assert len(accounts) == 1
    acc = accounts[0]
    assert acc.workspace_count == 1
    assert acc.account_scope == "workspace"
    # Falls back to the workspace name when the account has no label.
    assert acc.label == "name-ws-self"
    assert acc.total_forecast_eur == 500.0


def test_trial_account_excluded_from_revenue_and_flagged():
    from dembrane.api.v2.admin import _aggregate_accounts

    rows = [
        _ws_row(
            workspace_id="ws-t",
            account_id="acc-trial",
            tier="changemaker",
            seats=2,
            type_discount="trial",
            tier_expires_at="2026-07-18T00:00:00+00:00",
        )
    ]
    accounts = _aggregate_accounts(
        rows,
        org_name_by_id={"org-1": "Acme"},
        label_by_account={"acc-trial": "Trial co"},
        payment_mode_by_account={"acc-trial": "none"},
        now_iso="2026-06-18T00:00:00+00:00",
    )
    acc = accounts[0]
    assert acc.is_trial is True
    assert acc.is_comped is True
    # A Changemaker trial adds €0 to the paying total despite the 1500 sticker.
    assert acc.total_forecast_eur == 0.0
    assert acc.base_price_eur == 1500.0
    assert acc.tier_expires_at == "2026-07-18T00:00:00+00:00"


def test_comped_reverse_trial_shape_without_explicit_discount():
    from dembrane.api.v2.admin import _aggregate_accounts

    # payment_mode="none" + paid tier + future expiry = the grant_reverse_trial
    # shape, even if type_discount got cleared. Still a trial, still €0.
    rows = [
        _ws_row(
            workspace_id="ws-t",
            account_id="acc-trial",
            tier="guardian",
            tier_expires_at="2026-09-01T00:00:00+00:00",
        )
    ]
    accounts = _aggregate_accounts(
        rows,
        org_name_by_id={"org-1": "Acme"},
        label_by_account={"acc-trial": None},
        payment_mode_by_account={"acc-trial": "none"},
        now_iso="2026-06-18T00:00:00+00:00",
    )
    acc = accounts[0]
    assert acc.is_trial is True
    assert acc.total_forecast_eur == 0.0


def test_managed_account_flagged_and_counts_as_revenue():
    from dembrane.api.v2.admin import _aggregate_accounts

    rows = [
        _ws_row(
            workspace_id="ws-m",
            account_id="acc-managed",
            tier="guardian",
            seats=10,
        )
    ]
    accounts = _aggregate_accounts(
        rows,
        org_name_by_id={"org-1": "Acme"},
        label_by_account={"acc-managed": "Gov dept"},
        payment_mode_by_account={"acc-managed": "offline"},
        now_iso="2026-06-18T00:00:00+00:00",
    )
    acc = accounts[0]
    assert acc.is_managed is True
    assert acc.is_comped is False
    # Offline-invoiced: counts toward revenue.
    assert acc.total_forecast_eur == 5000.0


def test_free_account_contributes_zero_without_being_comped():
    from dembrane.api.v2.admin import _aggregate_accounts

    rows = [_ws_row(workspace_id="ws-f", account_id="acc-free", tier="free")]
    accounts = _aggregate_accounts(
        rows,
        org_name_by_id={"org-1": "Acme"},
        label_by_account={"acc-free": None},
        payment_mode_by_account={"acc-free": "none"},
        now_iso="2026-06-18T00:00:00+00:00",
    )
    acc = accounts[0]
    # Free has no sticker price, so it never contributes revenue and isn't a
    # comped paid tier.
    assert acc.base_price_eur is None
    assert acc.total_forecast_eur == 0.0
    assert acc.is_comped is False
    assert acc.is_trial is False


# ── full rollup: granting a trial does not raise the paying total ──


def _rollup_settings():
    billing = SimpleNamespace(mollie_enabled=False, mollie_test_mode=False)
    return SimpleNamespace(billing=billing)


def _two_workspace_rollup(*, second_is_trial: bool):
    """One paying Changemaker account + one Changemaker account that is either a
    second paying account or a comped trial."""
    second_account = {
        "id": "ws-2",
        "name": "WS Two",
        "org_id": "org-2",
        "tier": "changemaker",
        "billing_account_id": "acc-2",
        "account_scope": "workspace",
        "account_label": "Beta billing",
        "account_payment_mode": "none" if second_is_trial else "mollie",
        "type_discount": "trial" if second_is_trial else None,
        "tier_expires_at": "2026-07-18T00:00:00+00:00" if second_is_trial else None,
        "settings": {},
    }
    return [
        {
            "id": "ws-1",
            "name": "WS One",
            "org_id": "org-1",
            "tier": "changemaker",
            "billing_account_id": "acc-1",
            "account_scope": "workspace",
            "account_label": "Acme billing",
            "account_payment_mode": "mollie",
            "type_discount": None,
            "tier_expires_at": None,
            "settings": {},
        },
        second_account,
    ]


@pytest.mark.asyncio
@patch("dembrane.api.v2.admin._recent_login_count", new_callable=AsyncMock)
@patch("dembrane.api.v2.admin.compute_effective_seat_state", new_callable=AsyncMock)
@patch("dembrane.api.v2.admin._workspace_hours_this_cycle", new_callable=AsyncMock)
@patch("dembrane.api.v2.admin._workspace_admins", new_callable=AsyncMock)
@patch("dembrane.api.v2.admin._all_active_workspaces", new_callable=AsyncMock)
@patch("dembrane.api.v2.admin._org_name_map", new_callable=AsyncMock)
async def test_trial_does_not_inflate_total(
    mock_org_names,
    mock_workspaces,
    mock_admins,
    mock_hours,
    mock_seats,
    mock_logins,
):
    from dembrane.api.v2.admin import billing_rollup

    mock_org_names.return_value = {"org-1": "Acme", "org-2": "Beta"}
    mock_admins.return_value = []
    mock_hours.return_value = 1.0
    mock_seats.return_value = (1, 1, 0)
    mock_logins.return_value = 0

    # Two paying accounts: total = 2 * 1500.
    mock_workspaces.return_value = _two_workspace_rollup(second_is_trial=False)
    paying = await billing_rollup(_auth(), month_offset=0)
    assert paying.total_forecast_eur == 3000.0
    assert paying.account_count == 2
    assert paying.comped_account_count == 0

    # Second account is now a comped trial: paying total drops to 1500, the
    # trial is counted separately, MRR matches the single paying account.
    mock_workspaces.return_value = _two_workspace_rollup(second_is_trial=True)
    with_trial = await billing_rollup(_auth(), month_offset=0)
    assert with_trial.total_forecast_eur == 1500.0
    assert with_trial.mrr_eur == 1500.0
    assert with_trial.account_count == 2
    assert with_trial.trial_account_count == 1
    assert with_trial.comped_account_count == 1
    # Granting the trial did NOT raise the paying total over the all-paying case.
    assert with_trial.total_forecast_eur < paying.total_forecast_eur

    trial_acc = next(a for a in with_trial.accounts if a.billing_account_id == "acc-2")
    assert trial_acc.is_trial is True
    assert trial_acc.total_forecast_eur == 0.0


@pytest.mark.asyncio
@patch("dembrane.api.v2.admin._recent_login_count", new_callable=AsyncMock)
@patch("dembrane.api.v2.admin.compute_effective_seat_state", new_callable=AsyncMock)
@patch("dembrane.api.v2.admin._workspace_hours_this_cycle", new_callable=AsyncMock)
@patch("dembrane.api.v2.admin._workspace_admins", new_callable=AsyncMock)
@patch("dembrane.api.v2.admin._all_active_workspaces", new_callable=AsyncMock)
@patch("dembrane.api.v2.admin._org_name_map", new_callable=AsyncMock)
async def test_rollup_pools_org_account_across_workspaces(
    mock_org_names,
    mock_workspaces,
    mock_admins,
    mock_hours,
    mock_seats,
    mock_logins,
):
    from dembrane.api.v2.admin import billing_rollup

    mock_org_names.return_value = {"org-1": "Acme"}
    mock_admins.return_value = []
    mock_hours.return_value = 1.0
    mock_seats.return_value = (2, 2, 1)  # 2 members + 1 external per workspace
    mock_logins.return_value = 0
    mock_workspaces.return_value = [
        {
            "id": "ws-a",
            "name": "A",
            "org_id": "org-1",
            "tier": "guardian",
            "billing_account_id": "acc-org",
            "account_scope": "organisation",
            "account_label": "Acme billing",
            "account_payment_mode": "mollie",
            "settings": {},
        },
        {
            "id": "ws-b",
            "name": "B",
            "org_id": "org-1",
            "tier": "guardian",
            "billing_account_id": "acc-org",
            "account_scope": "organisation",
            "account_label": "Acme billing",
            "account_payment_mode": "mollie",
            "settings": {},
        },
    ]

    result = await billing_rollup(_auth(), month_offset=0)
    # Two workspaces, one pooled account.
    assert result.workspace_count == 2
    assert result.account_count == 1
    acc = result.accounts[0]
    assert acc.workspace_count == 2
    # Pooled seats: (2+2) members, (1+1) external.
    assert acc.seat_count == 4
    assert acc.external_count == 2
    # Guardian base charged once, not twice.
    assert acc.total_forecast_eur == 5000.0
    assert result.total_forecast_eur == 5000.0


@pytest.mark.asyncio
async def test_billing_rollup_rejects_non_staff():
    from fastapi import HTTPException

    from dembrane.api.v2.admin import billing_rollup

    with pytest.raises(HTTPException) as exc:
        await billing_rollup(_auth(is_admin=False), month_offset=0)
    assert exc.value.status_code == 403
