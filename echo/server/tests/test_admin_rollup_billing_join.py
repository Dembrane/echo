"""Regression test for ISSUE-022: the staff dashboard was failing because
`_all_active_workspaces` left `billing_account_id` as the joined object.

The workspace query requests nested billing fields
(billing_account_id.tier, ...), which makes Directus return
`billing_account_id` as a dict, not a scalar id. BillingRow.billing_account_id
is typed `Optional[str]`, so the dict tripped Pydantic and 500'd
/v2/admin/billing-rollup (the panel rendered "Could not load the rollup").

This guards the collapse-to-scalar fix and the commercial-field flatten.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest


@pytest.mark.asyncio
@patch("dembrane.api.v2.admin.async_directus")
async def test_billing_account_id_collapses_to_scalar(mock_directus):
    from dembrane.api.v2.admin import _all_active_workspaces

    # Shape Directus returns when nested billing fields are requested: the
    # relation comes back as a joined object carrying id + commercial fields.
    mock_directus.get_items = AsyncMock(
        return_value=[
            {
                "id": "ws-1",
                "name": "WS One",
                "org_id": "org-1",
                "billing_account_id": {
                    "id": "acc-1",
                    "tier": "changemaker",
                    "status": "active",
                    "downgraded_at": None,
                },
                "billed_to_team_id": None,
                "effective_client_team_id": None,
            }
        ]
    )

    rows = await _all_active_workspaces()
    assert len(rows) == 1
    ws = rows[0]
    # billing_account_id is the scalar account id, not the joined dict.
    assert ws["billing_account_id"] == "acc-1"
    assert isinstance(ws["billing_account_id"], str)
    # Commercial fields are flattened to the top level for downstream reads.
    assert ws["tier"] == "changemaker"
    assert ws["status"] == "active"


@pytest.mark.asyncio
@patch("dembrane.api.v2.admin.async_directus")
async def test_billing_account_id_none_when_unjoined(mock_directus):
    from dembrane.api.v2.admin import _all_active_workspaces

    # A workspace whose account didn't join (bare id or null) must stay scalar.
    mock_directus.get_items = AsyncMock(
        return_value=[
            {
                "id": "ws-2",
                "name": "WS Two",
                "org_id": "org-1",
                "billing_account_id": None,
                "billed_to_team_id": None,
                "effective_client_team_id": None,
            }
        ]
    )

    rows = await _all_active_workspaces()
    assert rows[0]["billing_account_id"] is None
