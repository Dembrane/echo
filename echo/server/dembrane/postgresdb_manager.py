import os
import asyncio
from logging import getLogger

from lightrag.kg.postgres_impl import PostgreSQLDB

logger = getLogger("postgresdbmanager")

class PostgresDBManager:
    """Loop-aware manager for :class:`~lightrag.kg.postgres_impl.PostgreSQLDB`.

    A single :class:`PostgreSQLDB` (and therefore a single *asyncpg* connection
    pool) must only ever be used from the event-loop in which it was created.
    If we hand the instance to a different loop we will eventually get the same
    cross-loop errors we just fixed for *LightRAG*.

    We therefore maintain **one** PostgreSQLDB per event-loop.  Accessors
    transparently give you the instance bound to the current loop, creating it
    on first use.
    """

    _instance: "PostgresDBManager | None" = None

    # Mapping: loop-id → PostgreSQLDB instance
    _db_by_loop: dict[int, PostgreSQLDB] = {}
    # Mapping: loop-id → initialisation lock (to avoid double init in same loop)
    _lock_by_loop: dict[int, asyncio.Lock] = {}

    def __new__(cls) -> "PostgresDBManager":
        if cls._instance is None:
            cls._instance = super(PostgresDBManager, cls).__new__(cls)
        return cls._instance

    @staticmethod
    def _get_loop_id() -> int:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = asyncio.get_event_loop()
        return id(loop)

    @classmethod
    async def _create_db_for_current_loop(cls) -> PostgreSQLDB:
        logger.info("Initializing PostgreSQLDB for new event loop …")
        postgres_config = {
            "host": os.environ["POSTGRES_HOST"],
            "port": os.environ["POSTGRES_PORT"],
            "user": os.environ["POSTGRES_USER"],
            "password": os.environ["POSTGRES_PASSWORD"],
            "database": os.environ["POSTGRES_DATABASE"],
        }
        db = PostgreSQLDB(config=postgres_config)
        await db.initdb()
        logger.info("PostgreSQLDB initialised successfully for this loop")
        return db

    @classmethod
    async def get_initialized_db(cls) -> PostgreSQLDB:
        """Return a :class:`PostgreSQLDB` tied to the **current** event-loop."""
        loop_id = cls._get_loop_id()

        # Ensure a lock object exists for this loop
        if loop_id not in cls._lock_by_loop:
            cls._lock_by_loop[loop_id] = asyncio.Lock()

        # Fast path: already initialised for this loop
        if loop_id in cls._db_by_loop:
            return cls._db_by_loop[loop_id]

        # Slow path: need to create it, guarded by the per-loop lock to avoid
        # racing within the same loop.
        async with cls._lock_by_loop[loop_id]:
            if loop_id not in cls._db_by_loop:
                cls._db_by_loop[loop_id] = await cls._create_db_for_current_loop()

        return cls._db_by_loop[loop_id]
