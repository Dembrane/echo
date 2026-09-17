"""resolve_project_billing_context: the one read that turns a portal project
into (account, tier, cap), cached per project so pings never hit Directus."""

from __future__ import annotations

import asyncio
from typing import Any, Optional

import pytest

import dembrane.free_tier as ft


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class _Cache:
    def __init__(self) -> None:
        self.store: dict[str, Any] = {}
        self.sets: list[tuple[str, Any, int]] = []

    async def get(self, key: str) -> Optional[Any]:
        return self.store.get(key)

    async def set(self, key: str, value: Any, ttl: int) -> None:
        self.store[key] = value
        self.sets.append((key, value, ttl))


@pytest.fixture
def world(monkeypatch):
    state = {
        "tier": "free",
        "workspace_id": "w1",
        "account": {"id": "b1", "label": "Acme", "tier": "free"},
    }
    cache = _Cache()

    async def get_item(collection: str, item_id: str, *a: Any, **k: Any) -> Optional[dict]:
        if collection == "project":
            return {"id": item_id, "workspace_id": state["workspace_id"]}
        if collection == "workspace":
            return {
                "id": item_id,
                "billing_account_id": state["account"]["id"] if state["account"] else None,
            }
        if collection == "billing_account":
            return state["account"]
        raise AssertionError(collection)

    monkeypatch.setattr(ft.directus_async.async_directus, "get_item", get_item)
    monkeypatch.setattr("dembrane.cache_utils.cache_get_json", cache.get)
    monkeypatch.setattr("dembrane.cache_utils.cache_set_json", cache.set)

    from dembrane.tier_capacity import TIER_CAPACITIES

    def set_tier_cap(tier: str, value: Optional[int]) -> None:
        cap = TIER_CAPACITIES[tier]
        monkeypatch.setitem(
            TIER_CAPACITIES,
            tier,
            cap.__class__(**{**cap.__dict__, "max_concurrent_portal_recordings": value}),
        )

    state["set_tier_cap"] = set_tier_cap
    state["cache"] = cache
    return state


def test_resolves_account_tier_and_cap(world) -> None:
    world["set_tier_cap"]("free", 3)
    ctx = _run(ft.resolve_project_billing_context("p1"))
    assert ctx == ft.BillingContext(
        account_id="b1", account_name="Acme", tier="free", cap=3, workspace_id="w1"
    )


def test_unlimited_tier_has_none_cap(world) -> None:
    assert _run(ft.resolve_project_billing_context("p1")).cap is None


def test_project_without_workspace_is_not_measured(world) -> None:
    world["workspace_id"] = None
    assert _run(ft.resolve_project_billing_context("p1")) is None


def test_workspace_without_account_is_not_measured(world) -> None:
    world["account"] = None
    assert _run(ft.resolve_project_billing_context("p1")) is None


def test_context_is_cached_for_sixty_seconds(world) -> None:
    world["set_tier_cap"]("free", 3)
    _run(ft.resolve_project_billing_context("p1"))
    key, value, ttl = world["cache"].sets[-1]
    assert key == ft.context_cache_key("p1")
    assert ttl == ft.CONTEXT_TTL_SECONDS
    assert value == {
        "account_id": "b1",
        "account_name": "Acme",
        "tier": "free",
        "cap": 3,
        "workspace_id": "w1",
    }


def test_cached_none_is_not_a_miss(world) -> None:
    world["workspace_id"] = None
    _run(ft.resolve_project_billing_context("p1"))
    assert world["cache"].store[ft.context_cache_key("p1")] == {"none": True}

    async def boom(*a: Any, **k: Any) -> dict:
        raise AssertionError("Directus read on a cache hit")

    ft.directus_async.async_directus.get_item = boom  # type: ignore[assignment]
    assert _run(ft.resolve_project_billing_context("p1")) is None


def test_directus_failure_resolves_none(world, monkeypatch) -> None:
    async def boom(*a: Any, **k: Any) -> dict:
        raise RuntimeError("directus down")

    monkeypatch.setattr(ft.directus_async.async_directus, "get_item", boom)
    assert _run(ft.resolve_project_billing_context("p1")) is None


def test_empty_project_id_is_none(world) -> None:
    assert _run(ft.resolve_project_billing_context("")) is None


def test_malformed_cache_entry_is_treated_as_a_miss(world) -> None:
    world["set_tier_cap"]("free", 3)
    world["cache"].store[ft.context_cache_key("p1")] = {"account_id": "b1", "bogus": 1}
    ctx = _run(ft.resolve_project_billing_context("p1"))
    assert ctx == ft.BillingContext(
        account_id="b1", account_name="Acme", tier="free", cap=3, workspace_id="w1"
    )
