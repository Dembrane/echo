"""Tests for app_user settings JSON feature flags under GET/PATCH /v2/me."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI
from redis.exceptions import LockError, LockNotOwnedError

from dembrane.api.v2.me import router
from dembrane.api.dependency_auth import DirectusSession, require_directus_session

_USER_ID = "test-user-123"
_APP_USER_ID = "au-test-123"


def _build_app(auth_user_id: str = _USER_ID) -> FastAPI:
    app = FastAPI()

    async def _fake_auth() -> DirectusSession:
        return DirectusSession(user_id=auth_user_id, is_admin=False)

    app.dependency_overrides[require_directus_session] = _fake_auth
    app.include_router(router, prefix="/v2/me")
    return app


@pytest.mark.asyncio
@patch("dembrane.api.v2.me.async_directus")
@patch("dembrane.api.v2.me.resolve_app_user")
@patch("dembrane.api.v2.me.get_directus_user_profile")
async def test_get_me_returns_settings(
    mock_get_profile: AsyncMock,
    mock_resolve_user: AsyncMock,
    mock_directus: AsyncMock,
):
    """GET /v2/me returns settings dict from app_user."""
    mock_get_profile.return_value = {
        "email": "test@example.com",
        "display_name": "Test User",
        "avatar": None,
    }
    # User has some existing feature flags
    mock_resolve_user.return_value = {
        "id": _APP_USER_ID,
        "email": "test@example.com",
        "display_name": "Test User",
        "settings": {"enable_collapsible_sidebar": True},
    }
    mock_directus.get_items = AsyncMock(return_value=[])  # No memberships, etc.

    app = _build_app()
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        response = await ac.get("/v2/me")

    assert response.status_code == 200
    data = response.json()
    assert data["settings"] == {"enable_collapsible_sidebar": True}


@pytest.mark.asyncio
@patch("dembrane.api.v2.me.async_directus")
@patch("dembrane.api.v2.me.get_app_user_or_raise")
async def test_patch_me_updates_and_merges_settings(
    mock_get_raise: AsyncMock,
    mock_directus: AsyncMock,
    monkeypatch: pytest.MonkeyPatch,
):
    """PATCH /v2/me updates and merges settings dict in app_user."""
    # Existing settings in app_user
    mock_get_raise.return_value = {
        "id": _APP_USER_ID,
        "settings": {"enable_collapsible_sidebar": False, "other_flag": True},
    }

    mock_directus.update_item = AsyncMock(return_value={"data": {}})
    _install_fake_redis(monkeypatch)

    app = _build_app()
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        response = await ac.patch(
            "/v2/me",
            json={
                "settings": {"enable_collapsible_sidebar": True}
            },
        )

    assert response.status_code == 200
    assert response.json() == {"status": "success"}

    # Verify update_item payload has the merged dict
    mock_directus.update_item.assert_called_once_with(
        "app_user",
        _APP_USER_ID,
        {
            "settings": {
                "enable_collapsible_sidebar": True,
                "other_flag": True,
            }
        },
    )


class _FakeLock:
    """Mimics redis.asyncio Lock: explicit acquire/release plus context manager."""

    def __init__(self, lock: "asyncio.Lock"):
        self._lock = lock

    async def acquire(self) -> bool:
        await self._lock.acquire()
        return True

    async def release(self) -> None:
        self._lock.release()

    async def __aenter__(self) -> "_FakeLock":
        await self.acquire()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> bool:
        await self.release()
        return False


class _FakeRedisLocks:
    """Models a correct distributed lock service: mutual exclusion per key."""

    def __init__(self) -> None:
        self._locks: dict[str, asyncio.Lock] = {}

    def lock(self, name: str, **_kwargs) -> _FakeLock:
        return _FakeLock(self._locks.setdefault(name, asyncio.Lock()))


def _install_fake_redis(monkeypatch: pytest.MonkeyPatch) -> _FakeRedisLocks:
    fake_redis = _FakeRedisLocks()

    async def fake_get_redis() -> _FakeRedisLocks:
        return fake_redis

    monkeypatch.setattr("dembrane.api.v2.me.get_redis_client", fake_get_redis)
    return fake_redis


@pytest.mark.asyncio
@patch("dembrane.api.v2.me.async_directus")
@patch("dembrane.api.v2.me.get_app_user_or_raise")
async def test_patch_me_concurrent_settings_writes_do_not_clobber(
    mock_get_raise: AsyncMock,
    mock_directus: AsyncMock,
    monkeypatch: pytest.MonkeyPatch,
):
    """Two concurrent PATCHes with different settings keys must both survive.

    Reproduces the read-merge-write lost-update race: each request reads the
    settings blob, merges its own key in Python, and writes the whole blob
    back. Without per-user serialization, the last write erases the other
    request's key.
    """
    store: dict = {"id": _APP_USER_ID, "settings": {}}

    async def fake_get(_user_id: str) -> dict:
        # Snapshot read, like Directus returning the current row
        return {"id": store["id"], "settings": dict(store["settings"])}

    async def fake_update(_collection: str, _item_id: str, payload: dict) -> dict:
        # Yield before committing, like real Directus write latency, so the
        # second request's read happens before this write lands
        await asyncio.sleep(0.05)
        store["settings"] = dict(payload["settings"])
        return {"data": {}}

    mock_get_raise.side_effect = fake_get
    mock_directus.update_item = AsyncMock(side_effect=fake_update)

    _install_fake_redis(monkeypatch)

    app = _build_app()
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        resp_a, resp_b = await asyncio.gather(
            ac.patch("/v2/me", json={"settings": {"release_video_seen": "2026-08"}}),
            ac.patch("/v2/me", json={"settings": {"race_test_flag": True}}),
        )

    assert resp_a.status_code == 200
    assert resp_b.status_code == 200
    assert store["settings"] == {
        "release_video_seen": "2026-08",
        "race_test_flag": True,
    }


class _FlakyReleaseLock(_FakeLock):
    """Lock whose key 'expired' mid-hold: release always fails."""

    async def release(self) -> None:
        await super().release()
        raise LockNotOwnedError("Cannot release a lock that's no longer owned")

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> bool:
        await self.release()
        return False


class _UnavailableLock(_FakeLock):
    """Lock that can never be acquired (someone else holds it)."""

    async def acquire(self) -> bool:
        return False

    async def __aenter__(self) -> "_FakeLock":
        raise LockError("Unable to acquire lock within the time specified")


@pytest.mark.asyncio
@patch("dembrane.api.v2.me.async_directus")
@patch("dembrane.api.v2.me.get_app_user_or_raise")
async def test_patch_me_succeeds_when_lock_release_fails(
    mock_get_raise: AsyncMock,
    mock_directus: AsyncMock,
    monkeypatch: pytest.MonkeyPatch,
):
    """A lock that expires before release (clock jump, slow request) must not
    fail the request: the settings write already committed."""
    mock_get_raise.return_value = {"id": _APP_USER_ID, "settings": {}}
    mock_directus.update_item = AsyncMock(return_value={"data": {}})

    fake_redis = _install_fake_redis(monkeypatch)
    monkeypatch.setattr(
        fake_redis,
        "lock",
        lambda name, **_kw: _FlakyReleaseLock(
            fake_redis._locks.setdefault(name, asyncio.Lock())
        ),
    )

    app = _build_app()
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        response = await ac.patch("/v2/me", json={"settings": {"flag": True}})

    assert response.status_code == 200
    assert response.json() == {"status": "success"}
    mock_directus.update_item.assert_called_once()


@pytest.mark.asyncio
@patch("dembrane.api.v2.me.async_directus")
@patch("dembrane.api.v2.me.get_app_user_or_raise")
async def test_patch_me_returns_503_when_lock_unavailable(
    mock_get_raise: AsyncMock,
    mock_directus: AsyncMock,
    monkeypatch: pytest.MonkeyPatch,
):
    """If the per-user lock cannot be acquired in time, fail loudly with 503
    instead of silently racing or returning a generic 500."""
    mock_get_raise.return_value = {"id": _APP_USER_ID, "settings": {}}
    mock_directus.update_item = AsyncMock(return_value={"data": {}})

    fake_redis = _install_fake_redis(monkeypatch)
    monkeypatch.setattr(
        fake_redis,
        "lock",
        lambda name, **_kw: _UnavailableLock(
            fake_redis._locks.setdefault(name, asyncio.Lock())
        ),
    )

    app = _build_app()
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        response = await ac.patch("/v2/me", json={"settings": {"flag": True}})

    assert response.status_code == 503
    assert response.headers.get("Retry-After") == "2"
    mock_directus.update_item.assert_not_called()
