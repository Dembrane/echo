"""SqlMapStore against the local Postgres, inside a throwaway schema.

Each module run copies the three Map tables (with their vector column, checks
and indexes) into `map_test_<hex>` next to a schema-local `project` table, and
drops the schema afterwards. Skipped, with the reason, when the database or the
Map tables are unreachable, so unit runs in CI skip it.

The races run their writers on separate connections that meet at a lock held by
a third, so each compare-and-set is exercised under real contention.
"""

from __future__ import annotations

import uuid
import asyncio
import hashlib
from typing import Any, Callable, Iterator, Awaitable

import pytest
import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

import dembrane.map.store as store_module
from dembrane.map.store import SqlMapStore, MapStoreError, ActiveAttemptExists, lease_of

pytestmark = pytest.mark.integration

TABLES = ("map_result", "map_embedding", "map_fact_check")
RECIPE = "map-arguments-v1"


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


CONFIG_A = _hash("config-a")
CONFIG_B = _hash("config-b")


def _base_dsn() -> str | None:
    try:
        from dembrane.settings import get_settings

        url = str(get_settings().database.database_url)
    except Exception:
        return None
    for prefix in ("postgresql+psycopg://", "postgresql+psycopg2://", "postgres://"):
        if url.startswith(prefix):
            return "postgresql://" + url[len(prefix) :]
    return url


def _unavailable(dsn: str | None) -> str | None:
    if not dsn:
        return "no database URL is configured"
    try:
        with psycopg.connect(dsn, connect_timeout=3) as connection:
            tables = connection.execute(
                "SELECT to_regclass('public.map_result'), to_regclass('public.map_embedding'),"
                " to_regclass('public.map_fact_check')"
            ).fetchone()
            column = connection.execute(
                """SELECT count(*) FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'map_embedding'
                     AND column_name = 'embedding'"""
            ).fetchone()
    except Exception as exc:
        return f"the local Postgres is unreachable ({type(exc).__name__})"
    if not tables or any(table is None for table in tables):
        return "the Map tables are missing (run add_map_schema.py)"
    if not column or not column[0]:
        return "map_embedding.embedding is missing (run add_map_vectors.sql)"
    return None


@pytest.fixture(scope="module")
def dsn() -> Iterator[str]:
    base = _base_dsn()
    reason = _unavailable(base)
    if reason:
        pytest.skip(f"Map store integration skipped: {reason}")
    assert base is not None
    schema = sql.Identifier(f"map_test_{uuid.uuid4().hex[:12]}")
    with psycopg.connect(base, autocommit=True) as connection:
        connection.execute(sql.SQL("CREATE SCHEMA {}").format(schema))
        try:
            connection.execute(
                sql.SQL("CREATE TABLE {}.project (id uuid PRIMARY KEY)").format(schema)
            )
            for table in TABLES:
                name = sql.Identifier(table)
                connection.execute(
                    sql.SQL("CREATE TABLE {s}.{t} (LIKE public.{t} INCLUDING ALL)").format(
                        s=schema, t=name
                    )
                )
                connection.execute(
                    sql.SQL(
                        "ALTER TABLE {s}.{t} ADD CONSTRAINT {fk} FOREIGN KEY (project_id)"
                        " REFERENCES {s}.project (id) ON DELETE CASCADE"
                    ).format(s=schema, t=name, fk=sql.Identifier(f"{table}_test_project_fk"))
                )
        except Exception:
            connection.execute(sql.SQL("DROP SCHEMA IF EXISTS {} CASCADE").format(schema))
            raise
    try:
        yield make_conninfo(base, options=f"-c search_path={schema.as_string()},public")
    finally:
        with psycopg.connect(base, autocommit=True) as connection:
            connection.execute(sql.SQL("DROP SCHEMA IF EXISTS {} CASCADE").format(schema))


async def _execute(dsn: str, query: str, params: tuple[Any, ...] = ()) -> list[tuple[Any, ...]]:
    async with await psycopg.AsyncConnection.connect(dsn, autocommit=True) as connection:
        cursor = await connection.execute(query, params)  # type: ignore[arg-type]
        return list(await cursor.fetchall()) if cursor.description else []


async def _project(dsn: str) -> str:
    project_id = str(uuid.uuid4())
    await _execute(dsn, "INSERT INTO project (id) VALUES (%s)", (project_id,))
    return project_id


async def _save(
    store: SqlMapStore,
    project_id: str,
    text: str,
    vector: list[float],
    *,
    config: str = CONFIG_A,
    dims: int | None = None,
) -> str:
    embedding_id, _stored = await store.save_embedding(
        project_id=project_id,
        input_hash=_hash(text),
        config_key=config,
        model="test/embedding-model",
        dims=len(vector) if dims is None else dims,
        vector=vector,
    )
    return embedding_id


async def _attempt(store: SqlMapStore, project_id: str) -> dict[str, Any]:
    return await store.create_attempt(project_id=project_id, recipe_version=RECIPE, requested_by="u1")


async def _count(dsn: str, table: str, project_id: str) -> int:
    rows = await _execute(dsn, f"SELECT count(*) FROM {table} WHERE project_id = %s", (project_id,))
    return int(rows[0][0])


@pytest.mark.asyncio
async def test_an_unreachable_database_is_a_store_error() -> None:
    store = SqlMapStore(dsn="postgresql://nobody@127.0.0.1:1/nothing?connect_timeout=1")
    with pytest.raises(MapStoreError):
        await store.latest_ready(str(uuid.uuid4()))


@pytest.mark.asyncio
async def test_store_connections_are_bounded_per_event_loop(monkeypatch: pytest.MonkeyPatch) -> None:
    main_loop = asyncio.get_running_loop()
    gate = asyncio.Event()
    open_now = 0
    peak = 0

    class _Cursor:
        async def __aenter__(self) -> _Cursor:
            return self

        async def __aexit__(self, *exc: Any) -> None:
            return None

        async def execute(self, *args: Any, **kwargs: Any) -> None:  # noqa: ARG002
            if asyncio.get_running_loop() is main_loop:
                await gate.wait()

        async def fetchone(self) -> None:
            return None

    class _Connection:
        def cursor(self) -> _Cursor:
            return _Cursor()

        async def close(self) -> None:
            nonlocal open_now
            open_now -= 1

    async def _connect(*args: Any, **kwargs: Any) -> _Connection:  # noqa: ARG001
        nonlocal open_now, peak
        open_now += 1
        peak = max(peak, open_now)
        return _Connection()

    monkeypatch.setattr(store_module.psycopg.AsyncConnection, "connect", _connect)
    store = SqlMapStore(dsn="postgresql://unused")
    project = str(uuid.uuid4())
    bound = store_module.MAX_CONNECTIONS_PER_LOOP

    waiting = [asyncio.create_task(store.latest_ready(project)) for _ in range(bound + 3)]
    for _ in range(100):
        if open_now == bound:
            break
        await asyncio.sleep(0.01)
    await asyncio.sleep(0.05)
    assert open_now == peak == bound

    # Another event loop (a worker's loop after a reset) has its own slots: it
    # neither waits on this loop's nor trips over a semaphore bound to it.
    assert await asyncio.to_thread(asyncio.run, store.latest_ready(project)) is None

    gate.set()
    assert await asyncio.gather(*waiting) == [None] * len(waiting)
    assert open_now == 0


# ── embeddings ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_vector_round_trips_and_stays_project_and_config_scoped(dsn: str) -> None:
    store = SqlMapStore(dsn=dsn)
    project = await _project(dsn)
    other = await _project(dsn)
    vector = [0.25, -0.5, 1.0]

    embedding_id = await _save(store, project, "trams", vector)
    loaded = await store.load_embeddings(project, CONFIG_A, [_hash("trams"), _hash("absent")])

    assert loaded == {_hash("trams"): (embedding_id, vector)}
    assert await store.vectors_by_ids(project, [embedding_id]) == {embedding_id: vector}
    assert await store.load_embeddings(project, CONFIG_B, [_hash("trams")]) == {}
    assert await store.load_embeddings(other, CONFIG_A, [_hash("trams")]) == {}
    assert await store.vectors_by_ids(other, [embedding_id]) == {}
    assert await store.load_embeddings(project, CONFIG_A, []) == {}
    assert await store.vectors_by_ids(project, []) == {}
    rows = await _execute(dsn, "SELECT model, dims FROM map_embedding WHERE id = %s", (embedding_id,))
    assert rows == [("test/embedding-model", 3)]


@pytest.mark.asyncio
async def test_cosine_distance_orders_known_vectors(dsn: str) -> None:
    store = SqlMapStore(dsn=dsn)
    project = await _project(dsn)
    vectors = {
        "same": [1.0, 0.0, 0.0],
        "close": [0.9, 0.1, 0.0],
        "orthogonal": [0.0, 1.0, 0.0],
        "opposite": [-1.0, 0.0, 0.0],
    }
    ids = {name: await _save(store, project, name, vector) for name, vector in vectors.items()}

    rows = await _execute(
        dsn,
        """SELECT id::text, embedding <=> %s::vector AS distance FROM map_embedding
           WHERE project_id = %s ORDER BY distance""",
        ("[1,0,0]", project),
    )

    assert [row[0] for row in rows] == [ids["same"], ids["close"], ids["orthogonal"], ids["opposite"]]
    assert rows[0][1] == pytest.approx(0.0, abs=1e-6)
    assert rows[2][1] == pytest.approx(1.0, abs=1e-6)
    assert rows[3][1] == pytest.approx(2.0, abs=1e-6)


@pytest.mark.asyncio
async def test_the_same_input_and_config_is_one_row_even_under_concurrent_saves(dsn: str) -> None:
    store = SqlMapStore(dsn=dsn)
    project = await _project(dsn)

    async def _save_vector(text: str, vector: list[float]) -> tuple[str, list[float]]:
        return await store.save_embedding(
            project_id=project,
            input_hash=_hash(text),
            config_key=CONFIG_A,
            model="test/embedding-model",
            dims=len(vector),
            vector=vector,
        )

    first = await _save(store, project, "duplicate", [1.0, 2.0])
    second_id, second_vector = await _save_vector("duplicate", [3.0, 4.0])
    assert second_id == first
    assert second_vector == [1.0, 2.0]  # the stored vector, never the loser's
    rows = await _execute(
        dsn,
        "SELECT embedding::text FROM map_embedding WHERE project_id = %s AND input_hash = %s",
        (project, _hash("duplicate")),
    )
    assert rows == [("[1,2]",)]  # the later writer never overwrites

    saved = await asyncio.gather(*(_save_vector("race", [0.5, 0.25 + i]) for i in range(8)))
    embedding_id, stored = (await store.load_embeddings(project, CONFIG_A, [_hash("race")]))[_hash("race")]
    assert {saved_id for saved_id, _vector in saved} == {embedding_id}
    assert all(vector == stored for _saved_id, vector in saved)
    assert await _count(dsn, "map_embedding", project) == 2


@pytest.mark.parametrize(
    ("vector", "dims"),
    [
        ([1.0, 2.0, 3.0], 4),
        ([0.0, 0.0, 0.0], 3),
        ([float("nan"), 1.0, 1.0], 3),
        ([float("inf"), 1.0, 1.0], 3),
        ([], 0),
    ],
    ids=["dims-mismatch", "zero", "nan", "inf", "empty"],
)
@pytest.mark.asyncio
async def test_the_database_rejects_unusable_vectors(dsn: str, vector: list[float], dims: int) -> None:
    store = SqlMapStore(dsn=dsn)
    project = await _project(dsn)

    with pytest.raises(MapStoreError):
        await _save(store, project, "bad", vector, dims=dims)
    assert await _count(dsn, "map_embedding", project) == 0


@pytest.mark.asyncio
async def test_configurations_with_different_dimensions_coexist(dsn: str) -> None:
    store = SqlMapStore(dsn=dsn)
    project = await _project(dsn)

    small = await _save(store, project, "same text", [1.0, 0.0, 0.0], config=CONFIG_A)
    large = await _save(store, project, "same text", [0.0, 1.0, 0.0, 0.0, 1.0], config=CONFIG_B)

    assert small != large
    assert len((await store.load_embeddings(project, CONFIG_A, [_hash("same text")]))[_hash("same text")][1]) == 3
    assert len((await store.load_embeddings(project, CONFIG_B, [_hash("same text")]))[_hash("same text")][1]) == 5
    assert set(await store.vectors_by_ids(project, [small, large])) == {small, large}


# ── result attempts ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_only_one_attempt_is_active_per_project_and_failures_do_not_block(dsn: str) -> None:
    store = SqlMapStore(dsn=dsn)
    project = await _project(dsn)

    first = await _attempt(store, project)
    assert first["status"] == "queued" and first["progress"]["stage"] == "queued"
    assert lease_of(first)
    with pytest.raises(ActiveAttemptExists) as raised:
        await _attempt(store, project)
    assert raised.value.row is not None and raised.value.row["id"] == first["id"]
    assert (await store.active_attempt(project))["id"] == first["id"]  # type: ignore[index]

    assert await store.fail(first["id"], "Saving the map failed.", lease=lease_of(first)) is True
    assert await store.fail(first["id"], "again", lease=lease_of(first)) is False
    second = await _attempt(store, project)
    assert lease_of(second) != lease_of(first)
    with pytest.raises(ActiveAttemptExists):
        await store.requeue(first["id"])
    other = await _attempt(store, await _project(dsn))

    assert (await store.latest_attempt(project))["id"] == second["id"]  # type: ignore[index]
    assert other["id"] != second["id"]
    assert await store.get_result("not-a-uuid") is None
    assert await store.get_result(str(uuid.uuid4())) is None


@pytest.mark.asyncio
async def test_heartbeats_expiry_and_requeue_only_touch_the_right_states(dsn: str) -> None:
    store = SqlMapStore(dsn=dsn)
    project = await _project(dsn)
    row = await _attempt(store, project)
    lease = lease_of(row)
    config = {"model": "m", "dims": 3, "key": "k"}

    assert await store.heartbeat(
        row["id"],
        lease=lease,
        status="extracting",
        progress={"stage": "extracting", "conversations_done": 1},
        source_fingerprint="f" * 64,
        embedding_config=config,
    )
    assert await store.heartbeat(row["id"], lease=lease, status="embedding", progress={"stage": "embedding"})
    await store.set_execution_ref(row["id"], "msg-1")
    stored = await store.get_result(row["id"])
    assert stored is not None
    assert stored["status"] == "embedding"
    assert stored["progress"] == {"stage": "embedding", "lease": lease}
    assert stored["source_fingerprint"] == "f" * 64 and stored["embedding_config"] == config
    assert stored["execution_ref"] == "msg-1"

    assert await store.expire_stale(project, 3600) == []
    await _execute(
        dsn, "UPDATE map_result SET updated_at = now() - interval '2 hours' WHERE id = %s", (row["id"],)
    )
    assert await store.expire_stale(project, 3600) == [row["id"]]
    assert await store.heartbeat(row["id"], lease=lease, status="embedding", progress={}) is False
    expired = await store.get_result(row["id"])
    assert expired is not None and expired["status"] == "failed"
    assert expired["error"] == "The generation stopped without finishing."

    requeued = await store.requeue(row["id"])
    assert requeued is not None and requeued["status"] == "queued" and requeued["error"] is None
    assert requeued["progress"]["stage"] == "embedding"
    assert lease_of(requeued) not in (None, lease)
    assert await store.requeue(row["id"]) is None


@pytest.mark.asyncio
async def test_a_requeued_attempt_refuses_every_write_of_the_worker_that_held_it(dsn: str) -> None:
    store = SqlMapStore(dsn=dsn)
    project = await _project(dsn)
    row = await _attempt(store, project)
    old = lease_of(row)
    saved = {"stage": "extracting", "extractions": {"c1": {"text_hash": "h"}}}
    assert await store.heartbeat(row["id"], lease=old, status="extracting", progress=saved)

    # The worker reads one long conversation for a long time: the API expires
    # the attempt, and a new request requeues it for another worker.
    await _execute(
        dsn, "UPDATE map_result SET updated_at = now() - interval '2 hours' WHERE id = %s", (row["id"],)
    )
    assert await store.expire_stale(project, 3600) == [row["id"]]
    requeued = await store.requeue(row["id"])
    assert requeued is not None
    new = lease_of(requeued)
    assert new and new != old
    assert requeued["progress"]["extractions"] == saved["extractions"]  # the saved work resumes

    # The first worker carries on: its heartbeat, failure and publish are refused.
    assert await store.heartbeat(row["id"], lease=old, status="extracting", progress=saved) is False
    assert await store.fail(row["id"], "Generating the map failed.", lease=old) is False
    assert await store.publish(row["id"], {"arguments": []}, {"stage": "ready"}, lease=old) == "inactive"
    untouched = await store.get_result(row["id"])
    assert untouched is not None and untouched["status"] == "queued"
    assert untouched["manifest"] is None and untouched["progress"] == requeued["progress"]

    # The second worker owns the attempt.
    assert await store.heartbeat(row["id"], lease=new, status="embedding", progress={"stage": "embedding"})
    assert lease_of(await store.get_result(row["id"])) == new
    assert await store.publish(row["id"], {"arguments": []}, {"stage": "ready"}, lease=new) == "ready"


@pytest.mark.asyncio
async def test_publish_is_atomic_and_never_replaces_a_newer_ready_revision(dsn: str) -> None:
    store = SqlMapStore(dsn=dsn)
    project = await _project(dsn)

    row = await _attempt(store, project)
    lease = lease_of(row)
    await store.heartbeat(row["id"], lease=lease, status="embedding", progress={"stage": "embedding"})
    manifest = {"arguments": [{"id": "a-1", "statement": "Trams."}]}
    assert (
        await store.publish(row["id"], manifest, {"stage": "ready", "embeddings_done": 3}, lease=lease)
        == "ready"
    )
    ready = await store.get_result(row["id"])
    assert ready is not None
    assert ready["status"] == "ready" and ready["manifest"] == manifest
    assert ready["progress"] == {"stage": "ready", "embeddings_done": 3}
    assert ready["completed_at"] is not None and ready["error"] is None
    assert (await store.latest_ready(project))["id"] == row["id"]  # type: ignore[index]
    assert await store.publish(row["id"], {}, {}, lease=lease) == "inactive"

    failed = await _attempt(store, project)
    await store.fail(failed["id"], "Saving the map failed.", lease=lease_of(failed))
    assert await store.publish(failed["id"], manifest, {}, lease=lease_of(failed)) == "inactive"
    assert (await store.get_result(failed["id"]))["status"] == "failed"  # type: ignore[index]

    older = await _attempt(store, project)
    await _execute(dsn, "UPDATE map_result SET status = 'failed' WHERE id = %s", (older["id"],))
    newer = await _attempt(store, project)
    assert await store.publish(newer["id"], manifest, {"stage": "ready"}, lease=lease_of(newer)) == "ready"
    await _execute(dsn, "UPDATE map_result SET status = 'embedding' WHERE id = %s", (older["id"],))
    # A worker without the lease cannot even mark the older attempt superseded.
    assert await store.publish(older["id"], {"arguments": []}, {}, lease="not-the-lease") == "inactive"
    assert (await store.get_result(older["id"]))["status"] == "embedding"  # type: ignore[index]
    assert (
        await store.publish(older["id"], {"arguments": []}, {"stage": "ready"}, lease=lease_of(older))
        == "superseded"
    )
    late = await store.get_result(older["id"])
    assert late is not None and late["status"] == "superseded" and late["manifest"] is None
    assert (await store.latest_ready(project))["id"] == newer["id"]  # type: ignore[index]


# ── fact checks ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_fact_check_attempts_dedupe_and_guard_late_writes(dsn: str) -> None:
    store = SqlMapStore(dsn=dsn)
    project = await _project(dsn)
    key = _hash("claim revision")

    async def _start(force: bool = False, stale_seconds: int = 900) -> tuple[dict[str, Any], bool]:
        return await store.start_fact_check(
            project_id=project,
            claim_key=key,
            statement="The bridge opened in 1932.",
            requested_by="u1",
            force=force,
            stale_seconds=stale_seconds,
        )

    row, dispatch = await _start()
    assert dispatch and row["status"] == "processing" and row["attempt"] == 1
    again, dispatch = await _start()
    assert not dispatch and again["attempt"] == 1

    finish = {"justification": "J", "model": "m", "prompt_version": "p"}
    assert not await store.complete_fact_check(row["id"], 2, verdict="true", sources=[], **finish)
    sources = [{"url": "https://archive.example", "title": "Archive"}]
    assert await store.complete_fact_check(row["id"], 1, verdict="false", sources=sources, **finish)
    checks = await store.fact_checks_for(project, [key, _hash("unchecked")])
    assert list(checks) == [key]
    assert checks[key]["status"] == "done" and checks[key]["verdict"] == "false"
    assert checks[key]["sources"] == sources

    done, dispatch = await _start()
    assert not dispatch and done["status"] == "done"
    forced, dispatch = await _start(force=True)
    assert dispatch and forced["attempt"] == 2 and forced["verdict"] is None and forced["sources"] is None

    cancelled = await store.cancel_fact_check(project, key)
    assert cancelled is not None and cancelled["status"] == "idle" and cancelled["attempt"] == 3
    assert not await store.complete_fact_check(row["id"], 2, verdict="true", sources=[], **finish)
    assert not await store.fail_fact_check(row["id"], 2, "late")
    still_idle = await store.cancel_fact_check(project, key)
    assert still_idle is not None and still_idle["status"] == "idle" and still_idle["attempt"] == 3
    assert await store.cancel_fact_check(project, _hash("never started")) is None

    restarted, dispatch = await _start()
    assert dispatch and restarted["attempt"] == 4
    assert await store.fail_fact_check(row["id"], 4, "The fact-check could not finish. Try again.")
    retried, dispatch = await _start()
    assert dispatch and retried["attempt"] == 5 and retried["error"] is None

    _unchanged, dispatch = await _start(stale_seconds=900)
    assert not dispatch
    await _execute(
        dsn, "UPDATE map_fact_check SET started_at = now() - interval '1 hour' WHERE id = %s", (row["id"],)
    )
    stale, dispatch = await _start(stale_seconds=900)
    assert dispatch and stale["attempt"] == 6
    assert (await store.get_fact_check(row["id"]))["attempt"] == 6  # type: ignore[index]
    assert await store.fact_checks_for(await _project(dsn), [key]) == {}


# ── races ───────────────────────────────────────────────────────────────


async def _all_waiting(dsn: str, application_name: str, racers: list[asyncio.Task[Any]]) -> bool:
    for _ in range(500):
        if any(racer.done() for racer in racers):
            return False
        rows = await _execute(
            dsn,
            """SELECT count(*) FROM pg_stat_activity
               WHERE application_name = %s AND wait_event_type = 'Lock'""",
            (application_name,),
        )
        if int(rows[0][0]) >= len(racers):
            return True
        await asyncio.sleep(0.02)
    return False


async def _race(
    dsn: str,
    lock: str,
    params: tuple[Any, ...] | None,
    *operations: Callable[[SqlMapStore], Awaitable[Any]],
) -> list[Any]:
    """Run the operations at once, each on its own connection.

    A third connection takes `lock` in an open transaction and releases it only
    when every operation is waiting on it, so they reach their compare-and-set
    together."""
    name = f"map_race_{uuid.uuid4().hex[:12]}"
    store = SqlMapStore(dsn=make_conninfo(dsn, application_name=name))
    async with await psycopg.AsyncConnection.connect(dsn) as holder:
        await holder.execute(lock, params)  # type: ignore[arg-type]
        racers = [asyncio.create_task(operation(store)) for operation in operations]
        met = await _all_waiting(dsn, name, racers)
        await holder.commit()
    results = await asyncio.gather(*racers)
    assert met, "the racers never all waited on the lock"
    return list(results)


@pytest.mark.asyncio
async def test_two_starts_of_one_claim_dispatch_it_once(dsn: str) -> None:
    store = SqlMapStore(dsn=dsn)
    project = await _project(dsn)
    key = _hash("raced claim")

    async def _start(racer: SqlMapStore) -> tuple[dict[str, Any], bool]:
        return await racer.start_fact_check(
            project_id=project,
            claim_key=key,
            statement="The bridge opened in 1932.",
            requested_by="u1",
            force=False,
            stale_seconds=900,
        )

    # A claim nobody checked yet: both inserts meet at the table lock.
    outcomes = await _race(
        dsn, "LOCK TABLE map_fact_check IN SHARE ROW EXCLUSIVE MODE", None, _start, _start
    )
    assert sorted(dispatch for _row, dispatch in outcomes) == [False, True]
    assert [row["attempt"] for row, _dispatch in outcomes] == [1, 1]
    assert await _count(dsn, "map_fact_check", project) == 1

    # A retry after an error: both updates meet at the row lock.
    check_id = outcomes[0][0]["id"]
    assert await store.fail_fact_check(check_id, 1, "The fact-check could not finish. Try again.")
    outcomes = await _race(
        dsn, "SELECT 1 FROM map_fact_check WHERE id = %s FOR UPDATE", (check_id,), _start, _start
    )
    assert sorted(dispatch for _row, dispatch in outcomes) == [False, True]
    assert [row["attempt"] for row, _dispatch in outcomes] == [2, 2]
    final = await store.get_fact_check(check_id)
    assert final is not None and final["status"] == "processing" and final["attempt"] == 2


@pytest.mark.asyncio
async def test_a_cancel_racing_a_completion_leaves_one_consistent_state(dsn: str) -> None:
    store = SqlMapStore(dsn=dsn)
    project = await _project(dsn)
    key = _hash("cancelled or checked")
    row, _dispatch = await store.start_fact_check(
        project_id=project,
        claim_key=key,
        statement="Trams are cheaper than buses.",
        requested_by="u1",
        force=False,
        stale_seconds=900,
    )

    async def _cancel(racer: SqlMapStore) -> dict[str, Any] | None:
        return await racer.cancel_fact_check(project, key)

    async def _complete(racer: SqlMapStore) -> bool:
        return await racer.complete_fact_check(
            row["id"], 1, verdict="false", justification="J", sources=[], model="m", prompt_version="p"
        )

    cancelled, completed = await _race(
        dsn, "SELECT 1 FROM map_fact_check WHERE id = %s FOR UPDATE", (row["id"],), _cancel, _complete
    )

    final = await store.get_fact_check(row["id"])
    assert final is not None and cancelled is not None
    if completed:
        assert final["status"] == "done" and final["attempt"] == 1 and final["verdict"] == "false"
        assert cancelled["status"] == "done"
    else:
        assert final["status"] == "idle" and final["attempt"] == 2 and final["verdict"] is None
        assert cancelled["status"] == "idle" and cancelled["attempt"] == 2


@pytest.mark.asyncio
async def test_two_publishes_of_one_attempt_make_one_ready_revision(dsn: str) -> None:
    store = SqlMapStore(dsn=dsn)
    project = await _project(dsn)
    row = await _attempt(store, project)
    lease = lease_of(row)
    await store.heartbeat(row["id"], lease=lease, status="embedding", progress={"stage": "embedding"})

    def _publish(label: str) -> Callable[[SqlMapStore], Awaitable[str]]:
        async def _run(racer: SqlMapStore) -> str:
            return await racer.publish(
                row["id"], {"arguments": [], "by": label}, {"stage": "ready"}, lease=lease
            )

        return _run

    outcomes = await _race(
        dsn,
        "SELECT 1 FROM map_result WHERE id = %s FOR UPDATE",
        (row["id"],),
        _publish("first"),
        _publish("second"),
    )

    assert sorted(outcomes) == ["inactive", "ready"]
    ready = await store.get_result(row["id"])
    assert ready is not None and ready["status"] == "ready"
    assert ready["manifest"]["by"] == ("first" if outcomes[0] == "ready" else "second")


# ── lifecycle ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_deleting_a_project_removes_its_results_vectors_and_checks(dsn: str) -> None:
    store = SqlMapStore(dsn=dsn)
    project = await _project(dsn)
    keeper = await _project(dsn)
    for owner in (project, keeper):
        await _attempt(store, owner)
        await _save(store, owner, "kept or not", [1.0, 1.0])
        await store.start_fact_check(
            project_id=owner, claim_key=_hash("k"), statement="s", requested_by=None, force=False, stale_seconds=60
        )

    await _execute(dsn, "DELETE FROM project WHERE id = %s", (project,))

    for table in TABLES:
        assert await _count(dsn, table, project) == 0
        assert await _count(dsn, table, keeper) == 1
