"""create_membership_row / reactivate_membership_row must swallow exactly
RECORD_NOT_UNIQUE (lost race = already a member) and re-raise everything else."""

from unittest.mock import AsyncMock

import pytest

from dembrane.directus import DirectusBadRequest
from dembrane.api.v2._invite_helpers import (
    create_membership_row,
    reactivate_membership_row,
)

# Real Directus error body for an insert that bounces off the unique index.
_NOT_UNIQUE_BODY = (
    '{"errors":[{"message":"Value for field \\"org_id, user_id\\" in collection '
    '\\"org_membership\\" has to be unique.","extensions":{"collection":'
    '"org_membership","field":"org_id, user_id","code":"RECORD_NOT_UNIQUE"}}]}'
)

_PAYLOAD = {"id": "m1", "org_id": "o1", "user_id": "u1", "role": "member"}


@pytest.mark.asyncio
async def test_create_returns_true_on_success():
    client = AsyncMock()
    assert await create_membership_row(client, "org_membership", _PAYLOAD) is True
    client.create_item.assert_awaited_once_with("org_membership", _PAYLOAD)


@pytest.mark.asyncio
async def test_create_returns_false_on_unique_violation():
    client = AsyncMock()
    client.create_item.side_effect = DirectusBadRequest(AssertionError(_NOT_UNIQUE_BODY))
    assert await create_membership_row(client, "org_membership", _PAYLOAD) is False


@pytest.mark.asyncio
async def test_create_reraises_other_errors():
    client = AsyncMock()
    client.create_item.side_effect = DirectusBadRequest(
        AssertionError('{"errors":[{"extensions":{"code":"FORBIDDEN"}}]}')
    )
    with pytest.raises(DirectusBadRequest):
        await create_membership_row(client, "org_membership", _PAYLOAD)


@pytest.mark.asyncio
async def test_reactivate_returns_false_on_unique_violation():
    client = AsyncMock()
    client.update_item.side_effect = DirectusBadRequest(AssertionError(_NOT_UNIQUE_BODY))
    assert (
        await reactivate_membership_row(
            client, "workspace_membership", "row1", {"deleted_at": None}
        )
        is False
    )


@pytest.mark.asyncio
async def test_reactivate_returns_true_on_success():
    client = AsyncMock()
    assert (
        await reactivate_membership_row(
            client, "workspace_membership", "row1", {"deleted_at": None}
        )
        is True
    )
    client.update_item.assert_awaited_once_with(
        "workspace_membership", "row1", {"deleted_at": None}
    )
