"""PostgreSQL access for the analysis package and Map's store.

Every store call opens its own connection. Autocommit cursors serve the
single-statement compare-and-set writes; `transaction` serves the few writes
that must commit together (publication, snapshot advancement, authored
revisions). Neither is ever held across a model call.
"""

from __future__ import annotations

import asyncio
import weakref
import threading
from typing import Any, AsyncIterator
from contextlib import asynccontextmanager

import psycopg
from psycopg.rows import dict_row

from dembrane.settings import get_settings

# A worker saves eight vectors at a time, so a process never holds more than
# this many connections at once per event loop. Per loop because a semaphore
# belongs to the loop it first waits on, and a worker process runs coroutines
# on more than one loop over its life. Map's store and the analysis store share
# these slots.
MAX_CONNECTIONS_PER_LOOP = 4
_connection_slots_by_loop: weakref.WeakKeyDictionary[
    asyncio.AbstractEventLoop, asyncio.Semaphore
] = weakref.WeakKeyDictionary()
_connection_slots_lock = threading.Lock()


def connection_slots() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    with _connection_slots_lock:
        slots = _connection_slots_by_loop.get(loop)
        if slots is None:
            slots = asyncio.Semaphore(MAX_CONNECTIONS_PER_LOOP)
            _connection_slots_by_loop[loop] = slots
        return slots


def database_dsn() -> str:
    url = str(get_settings().database.database_url)
    for prefix in ("postgresql+psycopg://", "postgresql+psycopg2://", "postgres://"):
        if url.startswith(prefix):
            return "postgresql://" + url[len(prefix) :]
    return url


Cursor = psycopg.AsyncCursor[dict[str, Any]]


@asynccontextmanager
async def autocommit_cursor(
    dsn: str | None, error: type[Exception]
) -> AsyncIterator[Cursor]:
    """One connection, autocommit, dict rows. A database failure becomes
    `error`; a unique or check violation passes through for the caller to
    interpret."""
    async with connection_slots():
        try:
            connection = await psycopg.AsyncConnection.connect(
                dsn or database_dsn(), autocommit=True, row_factory=dict_row
            )
        except (psycopg.Error, OSError) as exc:
            raise error(f"could not connect to the database: {exc}") from exc
        try:
            async with connection.cursor() as cursor:
                yield cursor
        except (psycopg.errors.UniqueViolation, psycopg.errors.CheckViolation):
            raise
        except psycopg.Error as exc:
            raise error(str(exc).strip()) from exc
        finally:
            await connection.close()


@asynccontextmanager
async def transaction(dsn: str | None, error: type[Exception]) -> AsyncIterator[Cursor]:
    """One connection and one explicit transaction: committed when the block
    finishes, rolled back when anything inside raises (a Python exception as
    much as a database error)."""
    async with connection_slots():
        try:
            connection = await psycopg.AsyncConnection.connect(
                dsn or database_dsn(), autocommit=False, row_factory=dict_row
            )
        except (psycopg.Error, OSError) as exc:
            raise error(f"could not connect to the database: {exc}") from exc
        try:
            async with connection.transaction():
                async with connection.cursor() as cursor:
                    yield cursor
        except (psycopg.errors.UniqueViolation, psycopg.errors.CheckViolation):
            raise
        except psycopg.Error as exc:
            raise error(str(exc).strip()) from exc
        finally:
            await connection.close()
