"""In-memory stand-ins for Map's storage, model and embedding calls.

`FakeMapStore` implements the whole `MapStore` protocol with the guards the
SQL enforces (one active attempt per project, writes only while an attempt is
active and only under its current lease, publish refusing to replace a newer
ready revision, one embedding row per project + input + configuration,
fact-check attempt guards), on a clock the test controls, with failures the
test can inject.

`FakeGenerationWorld` builds `GenerationDeps` whose transcripts, extractor,
embedder and event publisher are scripted and counted.
"""

from __future__ import annotations

import copy
import math
import uuid
import hashlib
from typing import Any, Callable, Awaitable
from datetime import datetime, timezone, timedelta
from collections import Counter

from dembrane.map import recipe
from dembrane.embedding import EmbeddingIdentity
from dembrane.map.store import (
    ACTIVE_STATUSES,
    MapStoreError,
    ActiveAttemptExists,
    lease_of,
    new_lease,
)
from dembrane.map.generate import GenerationDeps

PROJECT = "11111111-1111-4111-8111-111111111111"
OTHER_PROJECT = "22222222-2222-4222-8222-222222222222"


class FakeClock:
    """Wall time for rows (strictly increasing) and a monotonic time for deps."""

    def __init__(self) -> None:
        self._now = datetime(2026, 9, 15, 12, 0, tzinfo=timezone.utc)
        self._monotonic = 1_000.0

    def now(self) -> datetime:
        # Every row write moves time on a little, so created_at orders writes.
        self._now += timedelta(milliseconds=1)
        return self._now

    def peek(self) -> datetime:
        return self._now

    def advance(self, seconds: float) -> None:
        self._now += timedelta(seconds=seconds)
        self._monotonic += seconds

    def monotonic(self) -> float:
        return self._monotonic


class FakeMapStore:
    def __init__(self, clock: FakeClock | None = None) -> None:
        self.clock = clock or FakeClock()
        self.results: dict[str, dict[str, Any]] = {}
        self.embeddings: dict[str, dict[str, Any]] = {}
        self.fact_checks: dict[str, dict[str, Any]] = {}
        self.calls: Counter[str] = Counter()
        self.heartbeats: list[dict[str, Any]] = []
        # Failure injection.
        self.fail_save_embedding_on: int | None = None  # the Nth call raises
        self.expire_on_heartbeat: int | None = None  # the Nth call finds the attempt expired
        self.raise_on: dict[str, BaseException] = {}  # method name -> raised on every call

    def _enter(self, name: str) -> None:
        self.calls[name] += 1
        if name in self.raise_on:
            raise self.raise_on[name]

    # ── results ─────────────────────────────────────────────────────────

    def _active(self, project_id: str) -> dict[str, Any] | None:
        rows = [
            r
            for r in self.results.values()
            if r["project_id"] == project_id and r["status"] in ACTIVE_STATUSES
        ]
        return max(rows, key=lambda r: r["created_at"]) if rows else None

    def _owned(self, result_id: str, lease: str | None) -> dict[str, Any] | None:
        """The row, while it is active and still under this lease."""
        row = self.results.get(result_id)
        if not row or row["status"] not in ACTIVE_STATUSES or lease_of(row) != lease:
            return None
        return row

    async def create_attempt(
        self, *, project_id: str, recipe_version: str, requested_by: str | None
    ) -> dict[str, Any]:
        self._enter("create_attempt")
        active = self._active(project_id)
        if active:
            raise ActiveAttemptExists(copy.deepcopy(active))
        now = self.clock.now()
        row = {
            "id": str(uuid.uuid4()),
            "project_id": project_id,
            "status": "queued",
            "execution_ref": None,
            "source_fingerprint": None,
            "recipe_version": recipe_version,
            "embedding_config": None,
            "progress": {"stage": "queued", "lease": new_lease()},
            "manifest": None,
            "error": None,
            "requested_by": requested_by,
            "created_at": now,
            "updated_at": now,
            "completed_at": None,
        }
        self.results[row["id"]] = row
        return copy.deepcopy(row)

    async def get_result(self, result_id: str) -> dict[str, Any] | None:
        self._enter("get_result")
        row = self.results.get(result_id)
        return copy.deepcopy(row) if row else None

    async def active_attempt(self, project_id: str) -> dict[str, Any] | None:
        self._enter("active_attempt")
        return copy.deepcopy(self._active(project_id))

    async def latest_ready(self, project_id: str) -> dict[str, Any] | None:
        self._enter("latest_ready")
        rows = [
            r
            for r in self.results.values()
            if r["project_id"] == project_id and r["status"] == "ready"
        ]
        return copy.deepcopy(max(rows, key=lambda r: r["created_at"])) if rows else None

    async def latest_attempt(self, project_id: str) -> dict[str, Any] | None:
        self._enter("latest_attempt")
        rows = [r for r in self.results.values() if r["project_id"] == project_id]
        return copy.deepcopy(max(rows, key=lambda r: r["created_at"])) if rows else None

    async def set_execution_ref(self, result_id: str, execution_ref: str) -> None:
        self._enter("set_execution_ref")
        if result_id in self.results:
            self.results[result_id]["execution_ref"] = execution_ref

    async def heartbeat(
        self,
        result_id: str,
        *,
        lease: str | None,
        status: str,
        progress: dict[str, Any],
        source_fingerprint: str | None = None,
        embedding_config: dict[str, Any] | None = None,
    ) -> bool:
        self._enter("heartbeat")
        row = self.results.get(result_id)
        if row is None:
            return False
        if self.expire_on_heartbeat is not None and self.calls["heartbeat"] >= self.expire_on_heartbeat:
            if row["status"] in ACTIVE_STATUSES:
                row.update(status="failed", error="The generation stopped without finishing.")
            return False
        if self._owned(result_id, lease) is None:
            return False
        row["status"] = status
        row["progress"] = {**copy.deepcopy(progress), "lease": lease}
        if source_fingerprint is not None:
            row["source_fingerprint"] = source_fingerprint
        if embedding_config is not None:
            row["embedding_config"] = copy.deepcopy(embedding_config)
        row["updated_at"] = self.clock.now()
        self.heartbeats.append(copy.deepcopy(progress))
        return True

    async def fail(self, result_id: str, error: str, *, lease: str | None) -> bool:
        self._enter("fail")
        row = self._owned(result_id, lease)
        if row is None:
            return False
        now = self.clock.now()
        row.update(status="failed", error=error[:4000], updated_at=now, completed_at=now)
        return True

    async def expire_stale(self, project_id: str, stale_seconds: int) -> list[str]:
        self._enter("expire_stale")
        cutoff = self.clock.peek() - timedelta(seconds=stale_seconds)
        expired = []
        for row in self.results.values():
            if (
                row["project_id"] == project_id
                and row["status"] in ACTIVE_STATUSES
                and row["updated_at"] < cutoff
            ):
                now = self.clock.now()
                row.update(
                    status="failed",
                    error="The generation stopped without finishing.",
                    updated_at=now,
                    completed_at=now,
                )
                expired.append(row["id"])
        return expired

    async def requeue(self, result_id: str) -> dict[str, Any] | None:
        self._enter("requeue")
        row = self.results.get(result_id)
        if not row or row["status"] != "failed":
            return None
        active = self._active(row["project_id"])
        if active:
            raise ActiveAttemptExists(copy.deepcopy(active))
        row.update(
            status="queued",
            error=None,
            completed_at=None,
            updated_at=self.clock.now(),
            progress={**(row["progress"] or {}), "lease": new_lease()},
        )
        return copy.deepcopy(row)

    async def publish(
        self,
        result_id: str,
        manifest: dict[str, Any],
        progress: dict[str, Any],
        *,
        lease: str | None,
    ) -> str:
        self._enter("publish")
        row = self._owned(result_id, lease)
        if row is None:
            return "inactive"
        now = self.clock.now()
        newer_ready = any(
            other["project_id"] == row["project_id"]
            and other["status"] == "ready"
            and other["created_at"] > row["created_at"]
            for other in self.results.values()
        )
        if newer_ready:
            row.update(status="superseded", updated_at=now, completed_at=now)
            return "superseded"
        row.update(
            status="ready",
            manifest=copy.deepcopy(manifest),
            progress=copy.deepcopy(progress),
            error=None,
            updated_at=now,
            completed_at=now,
        )
        return "ready"

    # ── embeddings ──────────────────────────────────────────────────────

    async def load_embeddings(
        self, project_id: str, config_key: str, input_hashes: list[str]
    ) -> dict[str, tuple[str, list[float]]]:
        self._enter("load_embeddings")
        wanted = set(input_hashes)
        return {
            row["input_hash"]: (row["id"], list(row["embedding"]))
            for row in self.embeddings.values()
            if row["project_id"] == project_id
            and row["config_key"] == config_key
            and row["input_hash"] in wanted
        }

    async def save_embedding(
        self,
        *,
        project_id: str,
        input_hash: str,
        config_key: str,
        model: str,
        dims: int,
        vector: list[float],
    ) -> tuple[str, list[float]]:
        self._enter("save_embedding")
        if self.fail_save_embedding_on is not None and (
            self.calls["save_embedding"] == self.fail_save_embedding_on
        ):
            raise MapStoreError("injected: the database refused the write")
        # The SQL checks: dims match, finite values (pgvector), nonzero norm.
        if dims <= 0 or len(vector) != dims:
            raise MapStoreError("violates check constraint map_embedding_dims_match")
        if not all(math.isfinite(float(v)) for v in vector):
            raise MapStoreError("NaN or infinity not allowed in vector")
        if not any(float(v) for v in vector):
            raise MapStoreError("violates check constraint map_embedding_nonzero")
        for row in self.embeddings.values():
            if (row["project_id"], row["input_hash"], row["config_key"]) == (
                project_id,
                input_hash,
                config_key,
            ):
                # The conflict: the first writer's row and vector stand.
                return str(row["id"]), list(row["embedding"])
        row = {
            "id": str(uuid.uuid4()),
            "project_id": project_id,
            "input_hash": input_hash,
            "config_key": config_key,
            "model": model,
            "dims": dims,
            "embedding": [float(v) for v in vector],
            "created_at": self.clock.now(),
        }
        self.embeddings[row["id"]] = row
        return str(row["id"]), list(row["embedding"])

    async def vectors_by_ids(self, project_id: str, ids: list[str]) -> dict[str, list[float]]:
        self._enter("vectors_by_ids")
        return {
            embedding_id: list(self.embeddings[embedding_id]["embedding"])
            for embedding_id in ids
            if embedding_id in self.embeddings
            and self.embeddings[embedding_id]["project_id"] == project_id
        }

    # ── fact checks ─────────────────────────────────────────────────────

    def _check_row(self, project_id: str, claim_key: str) -> dict[str, Any] | None:
        for row in self.fact_checks.values():
            if row["project_id"] == project_id and row["claim_key"] == claim_key:
                return row
        return None

    async def fact_checks_for(
        self, project_id: str, claim_keys: list[str]
    ) -> dict[str, dict[str, Any]]:
        self._enter("fact_checks_for")
        wanted = set(claim_keys)
        return {
            row["claim_key"]: copy.deepcopy(row)
            for row in self.fact_checks.values()
            if row["project_id"] == project_id and row["claim_key"] in wanted
        }

    async def get_fact_check(self, fact_check_id: str) -> dict[str, Any] | None:
        self._enter("get_fact_check")
        row = self.fact_checks.get(fact_check_id)
        return copy.deepcopy(row) if row else None

    async def start_fact_check(
        self,
        *,
        project_id: str,
        claim_key: str,
        statement: str,
        requested_by: str | None,
        force: bool,
        stale_seconds: int,
    ) -> tuple[dict[str, Any], bool]:
        self._enter("start_fact_check")
        now = self.clock.now()
        row = self._check_row(project_id, claim_key)
        if row is None:
            row = {
                "id": str(uuid.uuid4()),
                "project_id": project_id,
                "claim_key": claim_key,
                "statement": statement,
                "status": "processing",
                "attempt": 1,
                "verdict": None,
                "justification": None,
                "sources": None,
                "error": None,
                "model": None,
                "prompt_version": None,
                "requested_by": requested_by,
                "started_at": now,
                "completed_at": None,
                "updated_at": now,
            }
            self.fact_checks[row["id"]] = row
            return copy.deepcopy(row), True
        restart = (
            row["status"] in ("idle", "error")
            or (force and row["status"] == "done")
            or (
                row["status"] == "processing"
                and row["started_at"] < now - timedelta(seconds=stale_seconds)
            )
        )
        if not restart:
            return copy.deepcopy(row), False
        row.update(
            status="processing",
            attempt=row["attempt"] + 1,
            statement=statement,
            verdict=None,
            justification=None,
            sources=None,
            error=None,
            requested_by=requested_by,
            started_at=now,
            completed_at=None,
            updated_at=now,
        )
        return copy.deepcopy(row), True

    async def complete_fact_check(
        self,
        fact_check_id: str,
        attempt: int,
        *,
        verdict: str,
        justification: str,
        sources: list[dict[str, str]],
        model: str,
        prompt_version: str,
    ) -> bool:
        self._enter("complete_fact_check")
        row = self.fact_checks.get(fact_check_id)
        if not row or row["attempt"] != attempt or row["status"] != "processing":
            return False
        now = self.clock.now()
        row.update(
            status="done",
            verdict=verdict,
            justification=justification,
            sources=copy.deepcopy(sources),
            model=model,
            prompt_version=prompt_version,
            error=None,
            completed_at=now,
            updated_at=now,
        )
        return True

    async def fail_fact_check(self, fact_check_id: str, attempt: int, error: str) -> bool:
        self._enter("fail_fact_check")
        row = self.fact_checks.get(fact_check_id)
        if not row or row["attempt"] != attempt or row["status"] != "processing":
            return False
        now = self.clock.now()
        row.update(status="error", error=error[:2000], completed_at=now, updated_at=now)
        return True

    async def cancel_fact_check(self, project_id: str, claim_key: str) -> dict[str, Any] | None:
        self._enter("cancel_fact_check")
        row = self._check_row(project_id, claim_key)
        if row is None:
            return None
        if row["status"] == "processing":
            row.update(status="idle", attempt=row["attempt"] + 1, updated_at=self.clock.now())
        return copy.deepcopy(row)


# ── generation deps ─────────────────────────────────────────────────────


def deterministic_vector(text: str, dims: int) -> list[float]:
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    values = [(digest[i % len(digest)] / 255.0) * 2 - 1 for i in range(dims)]
    if not any(values):
        values[0] = 1.0
    return values


def transcript(conversation_id: str, text: str, label: str | None = None) -> recipe.Transcript:
    return recipe.Transcript(
        id=conversation_id,
        label=label or f"Conversation {conversation_id}",
        created_at=f"2026-09-1{len(conversation_id) % 9}T10:00:00Z",
        text=text,
    )


def item(
    statement: str,
    *evidence: str,
    kind: str = "argument",
    valence: str = "positive",
) -> dict[str, Any]:
    return {"kind": kind, "statement": statement, "evidence": list(evidence), "valence": valence}


class FakeGenerationWorld:
    """Scripted transcripts, extractor answers and embeddings, with counters."""

    def __init__(
        self,
        transcripts: list[recipe.Transcript],
        items: dict[str, list[dict[str, Any]]],
        *,
        dims: int = 8,
        model: str = "fake/embedding-model",
        clock: FakeClock | None = None,
    ) -> None:
        self.transcripts = list(transcripts)
        self.items = items
        self.dims = dims
        self.model = model
        self.clock = clock or FakeClock()
        self.fail_extract: set[str] = set()
        self.extract_error: Callable[[str], BaseException] = lambda cid: RuntimeError(
            f"the extractor broke on {cid}"
        )
        self.vector_for: Callable[[str], Any] | None = None
        self.embed_error: BaseException | None = None
        # Awaited inside a call, before it answers: (conversation id, window index)
        # for the extractor, the embedded text for the embedder.
        self.during_extract: Callable[[str, int], Awaitable[None]] | None = None
        self.during_embed: Callable[[str], Awaitable[None]] | None = None
        self.extract_calls: Counter[str] = Counter()
        self.embed_calls: list[str] = []
        self.probe_calls = 0
        self.events: list[tuple[str, dict[str, Any]]] = []

    def identity(self) -> EmbeddingIdentity:
        return EmbeddingIdentity(model=self.model, endpoint="fake:endpoint", dims=self.dims)

    def set_transcript(self, updated: recipe.Transcript) -> None:
        self.transcripts = [updated if t.id == updated.id else t for t in self.transcripts]

    def event_types(self) -> list[str]:
        return [event["type"] for _project, event in self.events]

    def deps(self) -> GenerationDeps:
        async def transcripts(project_id: str) -> list[recipe.Transcript]:  # noqa: ARG001
            return list(self.transcripts)

        async def probe() -> EmbeddingIdentity:
            self.probe_calls += 1
            return self.identity()

        async def extract(
            *, conversation_id: str, window: str, window_index: int, window_count: int  # noqa: ARG001
        ) -> tuple[dict[str, Any], dict[str, int]]:
            self.extract_calls[conversation_id] += 1
            if self.during_extract is not None:
                await self.during_extract(conversation_id, window_index)
            if conversation_id in self.fail_extract:
                raise self.extract_error(conversation_id)
            answer = {"items": copy.deepcopy(self.items.get(conversation_id, []))}
            return answer, {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120}

        async def embed(text: str) -> list[float]:
            self.embed_calls.append(text)
            if self.during_embed is not None:
                await self.during_embed(text)
            if self.embed_error is not None:
                raise self.embed_error
            if self.vector_for is not None:
                return self.vector_for(text)
            return deterministic_vector(f"{self.model}\x1f{text}", self.dims)

        async def publish(project_id: str, event: dict[str, Any]) -> None:
            self.events.append((project_id, copy.deepcopy(event)))

        return GenerationDeps(
            transcripts=transcripts,
            probe=probe,
            extract=extract,
            embed=embed,
            publish=publish,
            clock=self.clock.monotonic,
        )


# ── ready results and a small async Redis ───────────────────────────────


def manifest_argument(
    node_id: str,
    statement: str,
    *,
    kind: str = "argument",
    valence: str = "positive",
    quotes: list[str] | None = None,
    conversation_id: str = "c1",
    embedding_id: str | None = None,
) -> dict[str, Any]:
    quotes = quotes or [statement.lower()]
    return {
        "id": node_id,
        "statement": statement,
        "kind": kind,
        "valence": valence,
        "claim_key": recipe.claim_key(statement, quotes) if kind == "claim" else None,
        "evidence": [
            {
                "conversation_id": conversation_id,
                "label": "Conversation 1",
                "created_at": "2026-09-14T10:00:00Z",
                "quotes": quotes,
            }
        ],
        "created_at": "2026-09-14T10:00:00Z",
        "input_hash": recipe.input_hash(statement),
        "embedding_id": embedding_id,
        "candidate_ids": [f"c-{node_id}"],
    }


async def ready_result(
    store: FakeMapStore,
    arguments: list[dict[str, Any]],
    *,
    project_id: str = PROJECT,
    with_vectors: bool = True,
    dims: int = 4,
) -> dict[str, Any]:
    """A published revision holding `arguments`, with stored vectors."""
    row = await store.create_attempt(
        project_id=project_id, recipe_version=recipe.RECIPE_VERSION, requested_by="u1"
    )
    for argument in arguments:
        if with_vectors and not argument.get("embedding_id"):
            argument["embedding_id"], _vector = await store.save_embedding(
                project_id=project_id,
                input_hash=argument["input_hash"],
                config_key="fake-config",
                model="fake/embedding-model",
                dims=dims,
                vector=deterministic_vector(argument["statement"], dims),
            )
    manifest = {
        "version": recipe.MANIFEST_VERSION,
        "recipe_version": recipe.RECIPE_VERSION,
        "arguments": arguments,
        "conversations": [{"id": "c1", "label": "Conversation 1", "created_at": None}],
        "consolidation": {},
        "stats": {"arguments": len(arguments)},
    }
    outcome = await store.publish(row["id"], manifest, {"stage": "ready"}, lease=lease_of(row))
    assert outcome == "ready"
    stored = await store.get_result(row["id"])
    assert stored is not None
    return stored


class FakeAsyncRedis:
    """get/set (nx, ex)/exists/delete, returning bytes like the real client."""

    def __init__(self) -> None:
        self.data: dict[str, bytes] = {}
        self.expiry: dict[str, int | None] = {}
        self.calls: Counter[str] = Counter()

    async def get(self, key: str) -> bytes | None:
        self.calls["get"] += 1
        return self.data.get(key)

    async def set(
        self, key: str, value: Any, *, nx: bool = False, ex: int | None = None
    ) -> bool | None:
        self.calls["set"] += 1
        if nx and key in self.data:
            return None
        self.data[key] = value if isinstance(value, bytes) else str(value).encode("utf-8")
        self.expiry[key] = ex
        return True

    async def exists(self, *keys: str) -> int:
        self.calls["exists"] += 1
        return sum(1 for key in keys if key in self.data)

    async def delete(self, *keys: str) -> int:
        self.calls["delete"] += 1
        removed = 0
        for key in keys:
            if self.data.pop(key, None) is not None:
                removed += 1
                self.expiry.pop(key, None)
        return removed
