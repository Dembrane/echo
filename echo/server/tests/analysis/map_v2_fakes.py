"""In-memory map view reads and ASGI harnesses for the v2 Map tests.

`MapWorld` shares one clock between the fake analysis store, Map's fake store
and the reads over both, so result and snapshot times order the way the SQL
rows do.
"""

from __future__ import annotations

import uuid
from typing import Any
from collections import Counter

from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI, APIRouter, HTTPException

from tests.map_fakes import PROJECT, FakeClock, FakeMapStore
from tests.analysis.fakes import FakeAnalysisStore
from tests.analysis.helpers import Recorder
from dembrane.analysis.executor import RunRequest, execute_inline
from dembrane.analysis.map_view import (
    PAYLOAD_VERSION,
    ResultLink,
    LineageHead,
    ProducerHead,
    advance_map_view,
)
from dembrane.analysis.contracts import Run, Snapshot, RunStatus, ScopeKind, RevisionStatus
from dembrane.api.dependency_auth import DirectusSession, require_directus_session

READ = ("project:read", "conversation:read")
WRITE = (*READ, "project:update")


class FakeMapViewReads:
    def __init__(self, store: FakeAnalysisStore, map_store: FakeMapStore) -> None:
        self.store = store
        self.map_store = map_store
        # result id -> manifest_version and snapshot_id, the columns Map's fake lacks
        self.links: dict[str, dict[str, Any]] = {}

    def _version(self, result_id: str) -> int:
        return int(self.links.get(result_id, {}).get("manifest_version", 1))

    def _link(self, row: dict[str, Any]) -> ResultLink:
        return ResultLink(
            id=row["id"],
            project_id=row["project_id"],
            status=row["status"],
            manifest_version=self._version(row["id"]),
            snapshot_id=self.links.get(row["id"], {}).get("snapshot_id"),
            recipe_version=row.get("recipe_version"),
            embedding_config=row.get("embedding_config"),
            created_at=row.get("created_at"),
            completed_at=row.get("completed_at"),
        )

    async def producer_heads(self, project_id: str) -> list[ProducerHead]:
        return sorted(
            (
                ProducerHead(str(s.recipe_id), s.scope_key, s.id, str(s.current_run_id))
                for s in self.store.scopes.values()
                if s.project_id == project_id and s.kind == ScopeKind.PRODUCER and s.current_run_id
            ),
            key=lambda h: (h.recipe_id, h.scope_key),
        )

    async def embedding_identity(self, project_id: str, config_key: str) -> tuple[str, int] | None:
        for row in self.store.embeddings.values():
            if row["project_id"] == project_id and row["config_key"] == config_key:
                return str(row["model"]), int(row["dims"])
        return None

    async def result_link(self, result_id: str) -> ResultLink | None:
        row = self.map_store.results.get(result_id)
        return self._link(row) if row else None

    async def legacy_results(self, project_id: str | None) -> list[ResultLink]:
        rows = [
            r
            for r in self.map_store.results.values()
            if r["status"] == "ready"
            and self._version(r["id"]) == 1
            and (project_id is None or r["project_id"] == project_id)
        ]
        rows.sort(key=lambda r: (r["project_id"], r["created_at"], r["id"]))
        return [self._link(r) for r in rows]

    async def ensure_v2_result(self, snapshot: Snapshot) -> str:
        for result_id, link in self.links.items():
            if link.get("manifest_version") == 2 and link.get("snapshot_id") == snapshot.id:
                return result_id
        now = self.map_store.clock.now()
        row = {
            "id": str(uuid.uuid4()),
            "project_id": snapshot.project_id,
            "status": "ready",
            "execution_ref": None,
            "source_fingerprint": None,
            "recipe_version": "map-view-v2",
            "embedding_config": snapshot.embedding_config,
            "progress": {"stage": "ready"},
            "manifest": {"version": PAYLOAD_VERSION, "snapshotId": snapshot.id},
            "error": None,
            "requested_by": snapshot.created_by,
            "created_at": now,
            "updated_at": now,
            "completed_at": now,
        }
        self.map_store.results[row["id"]] = row
        self.links[row["id"]] = {"manifest_version": 2, "snapshot_id": snapshot.id}
        return row["id"]

    async def lineage_heads(self, project_id: str, type_id: str, lineage_keys: list[str]) -> dict[str, LineageHead]:
        wanted = set(lineage_keys)
        return {
            record.lineage_key: LineageHead(record.id, record.current_revision_id)
            for record in self.store.objects.values()
            if record.project_id == project_id and record.type == type_id and record.lineage_key in wanted
        }

    async def link_legacy_snapshot(self, result_id: str, snapshot_id: str) -> bool:
        link = self.links.setdefault(result_id, {"manifest_version": 1})
        if link.get("manifest_version", 1) != 1 or link.get("snapshot_id") == snapshot_id:
            return False
        link["snapshot_id"] = snapshot_id
        return True

    async def revision_history(self, project_id: str, object_id: str) -> list[str]:
        rows = [
            r
            for r in self.store.revisions.values()
            if r.project_id == project_id and r.object_id == object_id and r.status == RevisionStatus.PUBLISHED
        ]
        return [r.id for r in sorted(rows, key=lambda r: r.revision_number)]

    def v2_results(self) -> list[str]:
        return [rid for rid, link in self.links.items() if link.get("manifest_version") == 2]


class Counting:
    """A store whose named reads are counted."""

    def __init__(self, store: Any, names: tuple[str, ...] = ("get_revisions", "get_relations", "vectors_by_ids", "load_embeddings")) -> None:
        self._store = store
        self._names = set(names)
        self.calls: Counter[str] = Counter()

    def __getattr__(self, name: str) -> Any:
        attribute = getattr(self._store, name)
        if name not in self._names:
            return attribute

        async def counted(*args: Any, **kwargs: Any) -> Any:
            self.calls[name] += 1
            return await attribute(*args, **kwargs)

        return counted


class MapWorld:
    def __init__(self) -> None:
        self.clock = FakeClock()
        self.store = FakeAnalysisStore(clock=self.clock)
        self.map_store = FakeMapStore(self.clock)
        self.reads = FakeMapViewReads(self.store, self.map_store)
        self.events: list[tuple[str, dict[str, Any]]] = []

    async def publish(self, project_id: str, event: dict[str, Any]) -> None:
        self.events.append((project_id, event))

    async def advance(self, project_id: str = PROJECT, **kwargs: Any) -> Snapshot:
        snapshot = await advance_map_view(project_id, store=self.store, reads=self.reads, publish=self.publish, **kwargs)
        assert snapshot is not None
        return snapshot

    def current(self, project_id: str = PROJECT, view_id: str = "map") -> Snapshot:
        (scope,) = [
            s
            for s in self.store.scopes.values()
            if s.project_id == project_id and s.kind == ScopeKind.VIEW and s.view_id == view_id
        ]
        return self.store.snapshots[str(scope.current_snapshot_id)]


async def inline(store: FakeAnalysisStore, recipe_id: str, key: str, *, project_id: str = PROJECT, mode: str = "refresh") -> Run:
    outcome = await execute_inline(
        RunRequest(project_id, recipe_id, "project", mode=mode, idempotency_key=key), store=store, deps=Recorder().deps()
    )
    assert outcome.run.status == RunStatus.READY, outcome.run
    return outcome.run


class Access:
    def __init__(self, project_id: str, allowed: tuple[str, ...]) -> None:
        self.project_id = project_id
        self.allowed = set(allowed)
        self.required: list[str] = []
        self.project = {"id": project_id, "name": "Harbour", "context": "Trams or buses."}

    def require(self, policy: str) -> None:
        self.required.append(policy)
        if policy not in self.allowed:
            raise HTTPException(status_code=403, detail="Not allowed")

    def allows(self, policy: str) -> bool:
        return policy in self.allowed


class Limiter:
    def __init__(self) -> None:
        self.users: list[str] = []

    async def check(self, user_id: str) -> None:
        self.users.append(user_id)


class Grants:
    """Project access like the real resolver: a project the caller cannot reach is a 404."""

    def __init__(self) -> None:
        self.access: dict[str, Access] = {}

    def grant(self, project_id: str, *policies: str) -> Access:
        self.access[project_id] = Access(project_id, policies)
        return self.access[project_id]

    async def resolve(self, project_id: str, auth: Any) -> Access:  # noqa: ARG002
        access = self.access.get(project_id)
        if access is None:
            raise HTTPException(status_code=404, detail="Project not found")
        return access


async def asgi_call(
    router: APIRouter,
    prefix: str,
    method: str,
    path: str,
    *,
    json: Any = None,
    headers: dict[str, str] | None = None,
    params: dict[str, str] | None = None,
    user_id: str = "du1",
) -> Any:
    app = FastAPI()
    app.include_router(router, prefix=prefix)

    async def _session() -> DirectusSession:
        return DirectusSession(user_id=user_id, is_admin=False, access_token="t", client=None)

    app.dependency_overrides[require_directus_session] = _session
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        return await client.request(method, f"{prefix}{path}", json=json, headers=headers, params=params)
