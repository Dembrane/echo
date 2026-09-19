"""Postgres fixtures for the analysis integration tests.

Each module run copies the analysis tables, `map_result` and `map_embedding`
into a throwaway schema `analysis_test_<hex>` next to a schema-local `project`
table, recreates the Directus foreign keys between them, and applies
`directus/migrations/add_analysis_constraints.sql` to that schema, so the tests
exercise the migration's real constraints, indexes and triggers. The schema is
dropped afterwards. Skipped, with the reason, when the database or the tables
are unavailable, so unit runs in CI skip it.
"""

from __future__ import annotations

import re
import uuid
import asyncio
from typing import Any, Callable, Iterator, Awaitable
from pathlib import Path

import pytest
import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

from dembrane.analysis.store import SqlAnalysisStore
from tests.analysis.fixture_recipes import (
    FixtureWorld,
    register_fixture_recipes,
    unregister_fixture_recipes,
)

SQL_FILE = Path(__file__).resolve().parents[3] / "directus" / "migrations" / "add_analysis_constraints.sql"
MAP_TABLES = ("map_result", "map_embedding")


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


def _analysis_tables(connection: psycopg.Connection[Any]) -> list[str]:
    rows = connection.execute(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'analysis\\_%'"
        " ORDER BY tablename"
    ).fetchall()
    return [str(row[0]) for row in rows]


def _unavailable(dsn: str | None) -> str | None:
    if not dsn:
        return "no database URL is configured"
    if not SQL_FILE.exists():
        return f"{SQL_FILE} is missing"
    try:
        with psycopg.connect(dsn, connect_timeout=3) as connection:
            tables = _analysis_tables(connection)
            column = connection.execute(
                """SELECT count(*) FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'map_result'
                     AND column_name = 'snapshot_id'"""
            ).fetchone()
    except Exception as exc:
        return f"the local Postgres is unreachable ({type(exc).__name__})"
    if len(tables) < 8:
        return "the analysis tables are missing (run add_analysis_schema.py)"
    if not column or not column[0]:
        return "map_result.snapshot_id is missing (run add_analysis_schema.py)"
    return None


def _migration_sql() -> str:
    # psql meta-commands are not SQL.
    return "\n".join(line for line in SQL_FILE.read_text().splitlines() if not line.startswith("\\"))


@pytest.fixture(scope="module")
def pg_dsn() -> Iterator[str]:
    base = _base_dsn()
    reason = _unavailable(base)
    if reason:
        pytest.skip(f"analysis store integration skipped: {reason}")
    assert base is not None
    name = f"analysis_test_{uuid.uuid4().hex[:12]}"
    schema = sql.Identifier(name)
    scoped = make_conninfo(base, options=f"-c search_path={name},public")
    with psycopg.connect(base, autocommit=True) as connection:
        tables = _analysis_tables(connection)
        foreign_keys = connection.execute(
            """SELECT conrelid::regclass::text, conname, pg_get_constraintdef(oid)
               FROM pg_constraint
               WHERE contype = 'f' AND connamespace = 'public'::regnamespace
                 AND conrelid::regclass::text = ANY(%s)""",
            ([*tables, *MAP_TABLES],),
        ).fetchall()
        connection.execute(sql.SQL("CREATE SCHEMA {}").format(schema))
        try:
            connection.execute(sql.SQL("CREATE TABLE {}.project (id uuid PRIMARY KEY)").format(schema))
            for table in tables:
                # Defaults and the primary key only: every other constraint,
                # index and trigger comes from the migration applied below.
                connection.execute(
                    sql.SQL("CREATE TABLE {s}.{t} (LIKE public.{t} INCLUDING DEFAULTS)").format(
                        s=schema, t=sql.Identifier(table)
                    )
                )
                connection.execute(
                    sql.SQL("ALTER TABLE {s}.{t} ADD PRIMARY KEY (id)").format(
                        s=schema, t=sql.Identifier(table)
                    )
                )
            for table in MAP_TABLES:
                # Map's own SQL-only checks and indexes come along.
                connection.execute(
                    sql.SQL("CREATE TABLE {s}.{t} (LIKE public.{t} INCLUDING ALL)").format(
                        s=schema, t=sql.Identifier(table)
                    )
                )
            with psycopg.connect(scoped, autocommit=True) as local:
                for table, constraint, definition in foreign_keys:
                    if not re.fullmatch(r"FOREIGN KEY \(\w+\) REFERENCES \w+\(id\)( ON DELETE (CASCADE|SET NULL))?", definition):
                        raise AssertionError(f"unexpected foreign key definition {definition!r}")
                    local.execute(
                        sql.SQL("ALTER TABLE {t} ADD CONSTRAINT {c} ").format(
                            t=sql.Identifier(table), c=sql.Identifier(constraint)
                        )
                        + sql.SQL(definition)  # type: ignore[arg-type]
                    )
                local.execute(_migration_sql())  # type: ignore[arg-type]
        except Exception:
            connection.execute(sql.SQL("DROP SCHEMA IF EXISTS {} CASCADE").format(schema))
            raise
    try:
        yield scoped
    finally:
        with psycopg.connect(base, autocommit=True) as connection:
            connection.execute(sql.SQL("DROP SCHEMA IF EXISTS {} CASCADE").format(schema))


@pytest.fixture
def world() -> Iterator[FixtureWorld]:
    """Scripted sources with the fixture recipes registered for one test."""
    fixture_world = FixtureWorld()
    ids = register_fixture_recipes(fixture_world)
    try:
        yield fixture_world
    finally:
        unregister_fixture_recipes(ids)


async def execute(dsn: str, query: str, params: tuple[Any, ...] | dict[str, Any] = ()) -> list[tuple[Any, ...]]:
    async with await psycopg.AsyncConnection.connect(dsn, autocommit=True) as connection:
        cursor = await connection.execute(query, params)  # type: ignore[arg-type]
        return list(await cursor.fetchall()) if cursor.description else []


async def new_project(dsn: str) -> str:
    project_id = str(uuid.uuid4())
    await execute(dsn, "INSERT INTO project (id) VALUES (%s)", (project_id,))
    return project_id


async def _all_waiting(dsn: str, application_name: str, racers: list[asyncio.Task[Any]]) -> bool:
    for _ in range(500):
        if any(racer.done() for racer in racers):
            return False
        rows = await execute(
            dsn,
            """SELECT count(*) FROM pg_stat_activity
               WHERE application_name = %s AND wait_event_type = 'Lock'""",
            (application_name,),
        )
        if int(rows[0][0]) >= len(racers):
            return True
        await asyncio.sleep(0.02)
    return False


async def race(
    dsn: str,
    lock: str,
    params: tuple[Any, ...] | None,
    *operations: Callable[[SqlAnalysisStore], Awaitable[Any]],
    store_kwargs: dict[str, Any] | None = None,
) -> list[Any]:
    """Run the operations at once, each on its own connections, meeting at a
    lock a third connection holds in an open transaction and releases only
    once every operation is waiting on it."""
    name = f"analysis_race_{uuid.uuid4().hex[:12]}"
    store = SqlAnalysisStore(dsn=make_conninfo(dsn, application_name=name), **(store_kwargs or {}))
    async with await psycopg.AsyncConnection.connect(dsn) as holder:
        await holder.execute(lock, params)  # type: ignore[arg-type]
        racers = [asyncio.create_task(operation(store)) for operation in operations]
        met = await _all_waiting(dsn, name, racers)
        await holder.commit()
    results = await asyncio.gather(*racers, return_exceptions=True)
    assert met, "the racers never all waited on the lock"
    return list(results)
