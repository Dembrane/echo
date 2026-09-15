"""SQL persistence for Map: result revisions, embeddings and fact-check states.

The three tables are Map-owned Directus collections; the vector column and the
indexes that guard concurrency are SQL-only (see
`directus/migrations/add_map_vectors.sql`). Every write here is one statement
in autocommit mode, so no transaction is ever held open across a model call.
Callers check project access before reaching this module; every query is
scoped by project or by an id the caller already resolved to a project.

Failures raise `MapStoreError`. Nothing here swallows a database error: a
result is only ready when its vectors are durable.
"""

from __future__ import annotations

import uuid
import logging
from typing import Any, Iterable, Protocol, AsyncIterator
from contextlib import asynccontextmanager

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Json

from dembrane.settings import get_settings

logger = logging.getLogger("dembrane.map.store")

ACTIVE_STATUSES = ("queued", "extracting", "embedding")

RESULT_COLUMNS = (
    "id::text AS id, project_id::text AS project_id, status, execution_ref, "
    "source_fingerprint, recipe_version, embedding_config, progress, manifest, "
    "error, requested_by, created_at, updated_at, completed_at"
)
FACT_CHECK_COLUMNS = (
    "id::text AS id, project_id::text AS project_id, claim_key, statement, status, "
    "attempt, verdict, justification, sources, error, model, prompt_version, "
    "requested_by, started_at, completed_at, updated_at"
)


class MapStoreError(RuntimeError):
    """The database refused or failed a Map read or write."""


class ActiveAttemptExists(Exception):
    def __init__(self, row: dict[str, Any] | None) -> None:
        super().__init__("a map generation is already in progress for this project")
        self.row = row


def vector_literal(vector: Iterable[float]) -> str:
    return "[" + ",".join(repr(float(value)) for value in vector) + "]"


def parse_vector(text: str) -> list[float]:
    body = str(text).strip()
    if not body.startswith("[") or not body.endswith("]"):
        raise MapStoreError("unreadable vector from the database")
    inner = body[1:-1].strip()
    return [float(part) for part in inner.split(",")] if inner else []


def _dsn() -> str:
    url = str(get_settings().database.database_url)
    for prefix in ("postgresql+psycopg://", "postgresql+psycopg2://", "postgres://"):
        if url.startswith(prefix):
            return "postgresql://" + url[len(prefix) :]
    return url


class MapStore(Protocol):
    """What the generation, fact-check and API code need from storage.

    `SqlMapStore` is the real implementation; tests use an in-memory one."""

    async def create_attempt(
        self, *, project_id: str, recipe_version: str, requested_by: str | None
    ) -> dict[str, Any]: ...
    async def get_result(self, result_id: str) -> dict[str, Any] | None: ...
    async def active_attempt(self, project_id: str) -> dict[str, Any] | None: ...
    async def latest_ready(self, project_id: str) -> dict[str, Any] | None: ...
    async def latest_attempt(self, project_id: str) -> dict[str, Any] | None: ...
    async def set_execution_ref(self, result_id: str, execution_ref: str) -> None: ...
    async def heartbeat(
        self,
        result_id: str,
        *,
        status: str,
        progress: dict[str, Any],
        source_fingerprint: str | None = None,
        embedding_config: dict[str, Any] | None = None,
    ) -> bool: ...
    async def fail(self, result_id: str, error: str) -> bool: ...
    async def expire_stale(self, project_id: str, stale_seconds: int) -> list[str]: ...
    async def requeue(self, result_id: str) -> dict[str, Any] | None: ...
    async def publish(
        self, result_id: str, manifest: dict[str, Any], progress: dict[str, Any]
    ) -> str: ...
    async def load_embeddings(
        self, project_id: str, config_key: str, input_hashes: list[str]
    ) -> dict[str, tuple[str, list[float]]]: ...
    async def save_embedding(
        self,
        *,
        project_id: str,
        input_hash: str,
        config_key: str,
        model: str,
        dims: int,
        vector: list[float],
    ) -> str: ...
    async def vectors_by_ids(self, project_id: str, ids: list[str]) -> dict[str, list[float]]: ...
    async def fact_checks_for(
        self, project_id: str, claim_keys: list[str]
    ) -> dict[str, dict[str, Any]]: ...
    async def get_fact_check(self, fact_check_id: str) -> dict[str, Any] | None: ...
    async def start_fact_check(
        self,
        *,
        project_id: str,
        claim_key: str,
        statement: str,
        requested_by: str | None,
        force: bool,
        stale_seconds: int,
    ) -> tuple[dict[str, Any], bool]: ...
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
    ) -> bool: ...
    async def fail_fact_check(self, fact_check_id: str, attempt: int, error: str) -> bool: ...
    async def cancel_fact_check(self, project_id: str, claim_key: str) -> dict[str, Any] | None: ...


class SqlMapStore:
    def __init__(self, dsn: str | None = None) -> None:
        self._dsn = dsn

    @asynccontextmanager
    async def _cursor(self) -> AsyncIterator[psycopg.AsyncCursor[dict[str, Any]]]:
        try:
            connection = await psycopg.AsyncConnection.connect(
                self._dsn or _dsn(), autocommit=True, row_factory=dict_row
            )
        except (psycopg.Error, OSError) as exc:
            raise MapStoreError(f"could not connect to the database: {exc}") from exc
        try:
            async with connection.cursor() as cursor:
                yield cursor
        except psycopg.errors.UniqueViolation:
            raise
        except psycopg.Error as exc:
            raise MapStoreError(str(exc).strip()) from exc
        finally:
            await connection.close()

    # ── results ─────────────────────────────────────────────────────────

    async def create_attempt(
        self, *, project_id: str, recipe_version: str, requested_by: str | None
    ) -> dict[str, Any]:
        try:
            async with self._cursor() as cursor:
                await cursor.execute(
                    f"""INSERT INTO map_result
                            (id, project_id, status, recipe_version, requested_by,
                             progress, created_at, updated_at)
                        VALUES (%s, %s, 'queued', %s, %s, %s, now(), now())
                        RETURNING {RESULT_COLUMNS}""",
                    (
                        str(uuid.uuid4()),
                        project_id,
                        recipe_version,
                        requested_by,
                        Json({"stage": "queued"}),
                    ),
                )
                row = await cursor.fetchone()
                assert row is not None
                return row
        except psycopg.errors.UniqueViolation:
            raise ActiveAttemptExists(await self.active_attempt(project_id)) from None

    async def _one_result(self, where: str, params: tuple[Any, ...]) -> dict[str, Any] | None:
        async with self._cursor() as cursor:
            await cursor.execute(f"SELECT {RESULT_COLUMNS} FROM map_result WHERE {where}", params)
            return await cursor.fetchone()

    async def get_result(self, result_id: str) -> dict[str, Any] | None:
        try:
            uuid.UUID(str(result_id))
        except ValueError:
            return None
        return await self._one_result("id = %s", (result_id,))

    async def active_attempt(self, project_id: str) -> dict[str, Any] | None:
        return await self._one_result(
            "project_id = %s AND status = ANY(%s) ORDER BY created_at DESC LIMIT 1",
            (project_id, list(ACTIVE_STATUSES)),
        )

    async def latest_ready(self, project_id: str) -> dict[str, Any] | None:
        return await self._one_result(
            "project_id = %s AND status = 'ready' ORDER BY created_at DESC LIMIT 1",
            (project_id,),
        )

    async def latest_attempt(self, project_id: str) -> dict[str, Any] | None:
        return await self._one_result(
            "project_id = %s ORDER BY created_at DESC LIMIT 1", (project_id,)
        )

    async def set_execution_ref(self, result_id: str, execution_ref: str) -> None:
        async with self._cursor() as cursor:
            await cursor.execute(
                "UPDATE map_result SET execution_ref = %s WHERE id = %s",
                (execution_ref, result_id),
            )

    async def heartbeat(
        self,
        result_id: str,
        *,
        status: str,
        progress: dict[str, Any],
        source_fingerprint: str | None = None,
        embedding_config: dict[str, Any] | None = None,
    ) -> bool:
        async with self._cursor() as cursor:
            await cursor.execute(
                """UPDATE map_result
                   SET status = %s,
                       progress = %s,
                       source_fingerprint = COALESCE(%s, source_fingerprint),
                       embedding_config = COALESCE(%s::json, embedding_config),
                       updated_at = now()
                   WHERE id = %s AND status = ANY(%s)""",
                (
                    status,
                    Json(progress),
                    source_fingerprint,
                    Json(embedding_config) if embedding_config is not None else None,
                    result_id,
                    list(ACTIVE_STATUSES),
                ),
            )
            return cursor.rowcount == 1

    async def fail(self, result_id: str, error: str) -> bool:
        async with self._cursor() as cursor:
            await cursor.execute(
                """UPDATE map_result
                   SET status = 'failed', error = %s, updated_at = now(), completed_at = now()
                   WHERE id = %s AND status = ANY(%s)""",
                (error[:4000], result_id, list(ACTIVE_STATUSES)),
            )
            return cursor.rowcount == 1

    async def expire_stale(self, project_id: str, stale_seconds: int) -> list[str]:
        async with self._cursor() as cursor:
            await cursor.execute(
                """UPDATE map_result
                   SET status = 'failed',
                       error = 'The generation stopped without finishing.',
                       updated_at = now(), completed_at = now()
                   WHERE project_id = %s AND status = ANY(%s)
                     AND updated_at < now() - make_interval(secs => %s)
                   RETURNING id::text AS id""",
                (project_id, list(ACTIVE_STATUSES), stale_seconds),
            )
            return [row["id"] for row in await cursor.fetchall()]

    async def requeue(self, result_id: str) -> dict[str, Any] | None:
        row = await self.get_result(result_id)
        try:
            async with self._cursor() as cursor:
                await cursor.execute(
                    f"""UPDATE map_result
                        SET status = 'queued', error = NULL, completed_at = NULL,
                            updated_at = now()
                        WHERE id = %s AND status = 'failed'
                        RETURNING {RESULT_COLUMNS}""",
                    (result_id,),
                )
                return await cursor.fetchone()
        except psycopg.errors.UniqueViolation:
            project_id = (row or {}).get("project_id")
            active = await self.active_attempt(project_id) if project_id else None
            raise ActiveAttemptExists(active) from None

    async def publish(
        self, result_id: str, manifest: dict[str, Any], progress: dict[str, Any]
    ) -> str:
        """Make an attempt the project's current revision, atomically.

        Returns "ready"; "superseded" when a newer attempt is already ready (an
        older attempt that finishes late never replaces it); "inactive" when
        the attempt is no longer running (failed or expired meanwhile)."""
        async with self._cursor() as cursor:
            await cursor.execute(
                """UPDATE map_result AS r
                   SET status = 'ready', manifest = %s, progress = %s, error = NULL,
                       completed_at = now(), updated_at = now()
                   WHERE r.id = %s AND r.status = ANY(%s)
                     AND NOT EXISTS (
                         SELECT 1 FROM map_result AS n
                         WHERE n.project_id = r.project_id
                           AND n.status = 'ready'
                           AND n.created_at > r.created_at
                     )""",
                (Json(manifest), Json(progress), result_id, list(ACTIVE_STATUSES)),
            )
            if cursor.rowcount == 1:
                return "ready"
            await cursor.execute(
                """UPDATE map_result
                   SET status = 'superseded', updated_at = now(), completed_at = now()
                   WHERE id = %s AND status = ANY(%s)""",
                (result_id, list(ACTIVE_STATUSES)),
            )
            return "superseded" if cursor.rowcount == 1 else "inactive"

    # ── embeddings ──────────────────────────────────────────────────────

    async def load_embeddings(
        self, project_id: str, config_key: str, input_hashes: list[str]
    ) -> dict[str, tuple[str, list[float]]]:
        if not input_hashes:
            return {}
        async with self._cursor() as cursor:
            await cursor.execute(
                """SELECT id::text AS id, input_hash, embedding::text AS embedding
                   FROM map_embedding
                   WHERE project_id = %s AND config_key = %s AND input_hash = ANY(%s)""",
                (project_id, config_key, list(input_hashes)),
            )
            return {
                row["input_hash"]: (row["id"], parse_vector(row["embedding"]))
                for row in await cursor.fetchall()
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
    ) -> str:
        """Insert once per (project, input, configuration); return the row id.

        A concurrent writer of the same vector loses the race harmlessly: the
        conflict leaves the first row, never a duplicate or an overwrite."""
        async with self._cursor() as cursor:
            await cursor.execute(
                """INSERT INTO map_embedding
                       (id, project_id, input_hash, config_key, model, dims, embedding, created_at)
                   VALUES (%s, %s, %s, %s, %s, %s, %s::vector, now())
                   ON CONFLICT (project_id, input_hash, config_key) DO NOTHING
                   RETURNING id::text AS id""",
                (
                    str(uuid.uuid4()),
                    project_id,
                    input_hash,
                    config_key,
                    model,
                    dims,
                    vector_literal(vector),
                ),
            )
            row = await cursor.fetchone()
            if row:
                return str(row["id"])
            await cursor.execute(
                """SELECT id::text AS id FROM map_embedding
                   WHERE project_id = %s AND input_hash = %s AND config_key = %s""",
                (project_id, input_hash, config_key),
            )
            existing = await cursor.fetchone()
            if not existing:
                raise MapStoreError("embedding row vanished after a conflicting insert")
            return str(existing["id"])

    async def vectors_by_ids(self, project_id: str, ids: list[str]) -> dict[str, list[float]]:
        if not ids:
            return {}
        async with self._cursor() as cursor:
            await cursor.execute(
                """SELECT id::text AS id, embedding::text AS embedding
                   FROM map_embedding
                   WHERE project_id = %s AND id = ANY(%s::uuid[])""",
                (project_id, list(ids)),
            )
            return {row["id"]: parse_vector(row["embedding"]) for row in await cursor.fetchall()}

    # ── fact checks ─────────────────────────────────────────────────────

    async def fact_checks_for(
        self, project_id: str, claim_keys: list[str]
    ) -> dict[str, dict[str, Any]]:
        if not claim_keys:
            return {}
        async with self._cursor() as cursor:
            await cursor.execute(
                f"""SELECT {FACT_CHECK_COLUMNS} FROM map_fact_check
                    WHERE project_id = %s AND claim_key = ANY(%s)""",
                (project_id, list(claim_keys)),
            )
            return {row["claim_key"]: row for row in await cursor.fetchall()}

    async def get_fact_check(self, fact_check_id: str) -> dict[str, Any] | None:
        async with self._cursor() as cursor:
            await cursor.execute(
                f"SELECT {FACT_CHECK_COLUMNS} FROM map_fact_check WHERE id = %s",
                (fact_check_id,),
            )
            return await cursor.fetchone()

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
        """Move a claim revision to processing, or leave a running check alone.

        Returns the row and whether the caller should dispatch the work: true
        for a new check, a retry after an error, a re-check of a finished one
        (`force`), or a check whose worker went quiet past `stale_seconds`."""
        async with self._cursor() as cursor:
            await cursor.execute(
                f"""INSERT INTO map_fact_check
                        (id, project_id, claim_key, statement, status, attempt,
                         requested_by, started_at, created_at, updated_at)
                    VALUES (%s, %s, %s, %s, 'processing', 1, %s, now(), now(), now())
                    ON CONFLICT (project_id, claim_key) DO UPDATE SET
                        status = 'processing',
                        attempt = map_fact_check.attempt + 1,
                        statement = EXCLUDED.statement,
                        verdict = NULL, justification = NULL, sources = NULL, error = NULL,
                        requested_by = EXCLUDED.requested_by,
                        started_at = now(), completed_at = NULL, updated_at = now()
                    WHERE map_fact_check.status IN ('idle', 'error')
                       OR (%s AND map_fact_check.status = 'done')
                       OR (map_fact_check.status = 'processing'
                           AND map_fact_check.started_at < now() - make_interval(secs => %s))
                    RETURNING {FACT_CHECK_COLUMNS}""",
                (
                    str(uuid.uuid4()),
                    project_id,
                    claim_key,
                    statement,
                    requested_by,
                    force,
                    stale_seconds,
                ),
            )
            row = await cursor.fetchone()
            if row:
                return row, True
            await cursor.execute(
                f"""SELECT {FACT_CHECK_COLUMNS} FROM map_fact_check
                    WHERE project_id = %s AND claim_key = %s""",
                (project_id, claim_key),
            )
            existing = await cursor.fetchone()
            if not existing:
                raise MapStoreError("fact-check row vanished after a conflicting insert")
            return existing, False

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
        """Write a verdict only for the attempt still running: a cancelled or
        superseded attempt that finishes late changes nothing."""
        async with self._cursor() as cursor:
            await cursor.execute(
                """UPDATE map_fact_check
                   SET status = 'done', verdict = %s, justification = %s, sources = %s,
                       model = %s, prompt_version = %s, error = NULL,
                       completed_at = now(), updated_at = now()
                   WHERE id = %s AND attempt = %s AND status = 'processing'""",
                (
                    verdict,
                    justification,
                    Json(sources),
                    model,
                    prompt_version,
                    fact_check_id,
                    attempt,
                ),
            )
            return cursor.rowcount == 1

    async def fail_fact_check(self, fact_check_id: str, attempt: int, error: str) -> bool:
        async with self._cursor() as cursor:
            await cursor.execute(
                """UPDATE map_fact_check
                   SET status = 'error', error = %s, completed_at = now(), updated_at = now()
                   WHERE id = %s AND attempt = %s AND status = 'processing'""",
                (error[:2000], fact_check_id, attempt),
            )
            return cursor.rowcount == 1

    async def cancel_fact_check(self, project_id: str, claim_key: str) -> dict[str, Any] | None:
        async with self._cursor() as cursor:
            await cursor.execute(
                f"""UPDATE map_fact_check
                    SET status = 'idle', attempt = attempt + 1, updated_at = now()
                    WHERE project_id = %s AND claim_key = %s AND status = 'processing'
                    RETURNING {FACT_CHECK_COLUMNS}""",
                (project_id, claim_key),
            )
            row = await cursor.fetchone()
            if row:
                return row
            await cursor.execute(
                f"""SELECT {FACT_CHECK_COLUMNS} FROM map_fact_check
                    WHERE project_id = %s AND claim_key = %s""",
                (project_id, claim_key),
            )
            return await cursor.fetchone()
