import os
import asyncio
from logging import getLogger

from lightrag.kg.postgres_impl import PostgreSQLDB

logger = getLogger("postgresdbmanager")

class PostgresDBManager:
    """
    Singleton class to manage the PostgreSQLDB instance.
    """
    _instance: "PostgresDBManager | None" = None
    _db: PostgreSQLDB | None = None
    _lock = asyncio.Lock() 

    def __new__(cls) -> "PostgresDBManager":
        if cls._instance is None:
            cls._instance = super(PostgresDBManager, cls).__new__(cls)
            cls._db = None
        return cls._instance

    async def _initialize_db(self) -> None:
        """Internal method to perform the actual DB initialization."""
        logger.info("Initializing PostgreSQLDB...")
        postgres_config = {
            "host": os.environ["POSTGRES_HOST"],
            "port": os.environ["POSTGRES_PORT"],
            "user": os.environ["POSTGRES_USER"],
            "password": os.environ["POSTGRES_PASSWORD"],
            "database": os.environ["POSTGRES_DATABASE"],
        }
        try:
            self._db = PostgreSQLDB(config=postgres_config)
            await self._db.initdb() 
            logger.info("PostgreSQLDB initialized successfully.")
        except Exception as e:
            logger.exception("Failed to initialize PostgreSQLDB")
            self._db = None 
            raise e 

    async def initialize(self) -> None:
        """Initializes the database connection if not already initialized. Uses a lock for async safety."""
        if self._db is None:
            async with self._lock: 
                if self._db is None: 
                   await self._initialize_db()

    def get_db(self) -> PostgreSQLDB:
        """Returns the initialized database instance. Raises error if not initialized."""
        if self._db is None:
            logger.error("PostgreSQLDB accessed before initialization.")
            raise RuntimeError("PostgreSQLDB has not been initialized. Call initialize() first.")
        return self._db

    @classmethod
    async def get_initialized_db(cls) -> PostgreSQLDB:
        """Gets the singleton instance and ensures it's initialized."""
        instance = cls()
        await instance.initialize()
        return instance.get_db()
