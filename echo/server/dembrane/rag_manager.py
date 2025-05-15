import asyncio
from typing import Optional
from logging import getLogger

from lightrag import LightRAG

from dembrane.config import DATABASE_URL
from dembrane.audio_lightrag.utils.litellm_utils import embedding_func, llm_model_func
from dembrane.audio_lightrag.utils.lightrag_utils import _load_postgres_env_vars

_load_postgres_env_vars(str(DATABASE_URL))
logger = getLogger(__name__)

class RAGManager:
    _instance: Optional[LightRAG] = None
    _initialized: bool = False
    # Keep track of which asyncio event loop the current LightRAG instance
    # belongs to.  LightRAG creates resources (e.g. asyncpg pools) that are
    # tightly coupled to the loop in which they were instantiated.  If we
    # subsequently try to use that same instance from another thread that has
    # its *own* event loop, asyncio will raise
    #     "Task got Future attached to a different loop".
    #
    # We therefore ensure that each distinct event-loop gets *its own* LightRAG
    # instance.  We store them in a dictionary keyed by the loop object.  For
    # most server setups there is only one loop, so the behaviour is unchanged
    # – but when dramatiq runs tasks in multiple threads (each of which can
    # have its own loop) we avoid cross-loop access.
    _instances_by_loop: dict[int, LightRAG] = {}

    @classmethod
    def get_instance(cls) -> LightRAG:
        try:
            current_loop = asyncio.get_running_loop()
        except RuntimeError:
            # Called from a non-async context – fall back to the default loop
            current_loop = asyncio.get_event_loop()

        loop_id = id(current_loop)

        if loop_id not in cls._instances_by_loop:
            raise RuntimeError(
                "RAG instance for this event loop not initialized. Call initialize() first."
            )

        return cls._instances_by_loop[loop_id]

    @classmethod
    def is_initialized(cls) -> bool:
        try:
            current_loop = asyncio.get_running_loop()
        except RuntimeError:
            current_loop = asyncio.get_event_loop()

        loop_id = id(current_loop)

        return loop_id in cls._instances_by_loop

    @classmethod
    async def initialize(cls) -> None:
        # Determine the event loop for which we want to (maybe) create a new
        # LightRAG instance.
        try:
            current_loop = asyncio.get_running_loop()
        except RuntimeError:
            current_loop = asyncio.get_event_loop()

        loop_id = id(current_loop)

        if loop_id in cls._instances_by_loop:
            logger.debug("RAG instance already initialized for this event loop; skipping")
            return

        logger.info("Initializing RAG instance for event loop %s", loop_id)

        instance = LightRAG(
            working_dir=None,
            llm_model_func=llm_model_func,
            embedding_func=embedding_func,
            kv_storage="PGKVStorage",
            doc_status_storage="PGDocStatusStorage",
            graph_storage="Neo4JStorage",
            vector_storage="PGVectorStorage",
            vector_db_storage_cls_kwargs={"cosine_better_than_threshold": 0.2},
        )
        await instance.initialize_storages()

        cls._instances_by_loop[loop_id] = instance
        # Keep the legacy single-instance attributes for backwards
        # compatibility with code that still references them.
        cls._instance = instance
        cls._initialized = True
        logger.info("RAG instance initialised for loop %s", loop_id)


# Convenience function to get the RAG instance
def get_rag() -> LightRAG:
    return RAGManager.get_instance()

# Initialize at application startup
async def initialize_rag_at_startup() -> None:
    """
    Initialize the RAG system once at application startup.
    This should be called when your FastAPI application starts.
    """
    if not RAGManager.is_initialized():
        logger.info("Initializing RAG system at application startup")
        await RAGManager.initialize()
        logger.info("RAG system initialized successfully")
    else:
        logger.info("RAG system already initialized") 