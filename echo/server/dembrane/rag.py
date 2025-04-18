from typing import Optional
from logging import getLogger

from lightrag import LightRAG

from dembrane.audio_lightrag.utils.litellm_utils import embedding_func, llm_model_func

logger = getLogger(__name__)

class RAGManager:
    _instance: Optional[LightRAG] = None
    _initialized: bool = False

    @classmethod
    def get_instance(cls) -> LightRAG:
        if cls._instance is None:
            raise RuntimeError("RAG instance not initialized. Call initialize() first.")
        return cls._instance

    @classmethod
    def is_initialized(cls) -> bool:
        return cls._initialized

    @classmethod
    async def initialize(cls) -> None:
        if cls._initialized:
            logger.debug("RAG instance already initialized, skipping initialization")
            return

        if cls._instance is None:
            cls._instance = LightRAG(
                working_dir=None,
                llm_model_func=llm_model_func,
                embedding_func=embedding_func,
                kv_storage="PGKVStorage",
                doc_status_storage="PGDocStatusStorage",
                graph_storage="Neo4JStorage",
                vector_storage="PGVectorStorage",
                vector_db_storage_cls_kwargs={
                    "cosine_better_than_threshold": 0.2
                }
            )
            await cls._instance.initialize_storages()
            cls._initialized = True
            logger.info("RAG instance has been initialized")
        else:
            logger.warning("RAG instance already created but not fully initialized")
            cls._initialized = True

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