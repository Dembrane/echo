import time
from typing import Any, AsyncGenerator
from logging import getLogger
from contextlib import asynccontextmanager

import nest_asyncio
from fastapi import (
    FastAPI,
    Request,
    HTTPException,
)
from lightrag import LightRAG
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware import Middleware
from fastapi.openapi.utils import get_openapi
from starlette.middleware.cors import CORSMiddleware
from lightrag.kg.shared_storage import initialize_pipeline_status

from dembrane.config import (
    REDIS_URL,
    DATABASE_URL,
    DISABLE_CORS,
    ADMIN_BASE_URL,
    SERVE_API_DOCS,
    PARTICIPANT_BASE_URL,
)
from dembrane.sentry import init_sentry
from dembrane.api.api import api
from dembrane.directus import directus
from dembrane.api.verify import seed_default_verification_topics
from dembrane.async_helpers import run_in_thread_pool
from dembrane.postgresdb_manager import PostgresDBManager

# from lightrag.llm.azure_openai import azure_openai_complete
from dembrane.audio_lightrag.utils.litellm_utils import embedding_func, llm_model_func
from dembrane.audio_lightrag.utils.lightrag_utils import (
    with_distributed_lock,
    _load_postgres_env_vars,
    check_audio_lightrag_tables,
)

# LightRAG requires nest_asyncio for nested event loops
nest_asyncio.apply()

logger = getLogger("server")


DEFAULT_DIRECTUS_LANGUAGES = [
    {"code": "en-US", "name": "English (United States)", "direction": "ltr"},
    {"code": "nl-NL", "name": "Dutch (Netherlands)", "direction": "ltr"},
    {"code": "de-DE", "name": "German (Germany)", "direction": "ltr"},
    {"code": "es-ES", "name": "Spanish (Spain)", "direction": "ltr"},
    {"code": "fr-FR", "name": "French (France)", "direction": "ltr"},
]


async def seed_default_languages() -> None:
    for language in DEFAULT_DIRECTUS_LANGUAGES:
        existing = await run_in_thread_pool(
            directus.get_items,
            "languages",
            {
                "query": {
                    "filter": {"code": {"_eq": language["code"]}},
                    "fields": ["code"],
                    "limit": 1,
                }
            },
        )

        if existing:
            continue

        logger.info("Seeding language %s", language["code"])
        await run_in_thread_pool(
            directus.create_item,
            "languages",
            {
                "code": language["code"],
                "name": language["name"],
                "direction": language["direction"],
            },
        )


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncGenerator[None, None]:
    # startup
    logger.info("starting server")
    init_sentry()

    # Initialize PostgreSQL and LightRAG
    _load_postgres_env_vars(str(DATABASE_URL))
    postgres_db = await PostgresDBManager.get_initialized_db()

    # Define the critical initialization operation
    async def initialize_database() -> bool:
        await postgres_db.initdb()
        await postgres_db.check_tables()
        await check_audio_lightrag_tables(postgres_db)
        return True

    # Use distributed lock for initialization
    _, _ = await with_distributed_lock(
        redis_url=str(REDIS_URL),
        lock_key="DEMBRANE_INIT_LOCK",
        critical_operation=initialize_database,
    )

    # This part is always needed, regardless of whether we performed initialization
    _app.state.rag = LightRAG(
        working_dir=None,
        llm_model_func=llm_model_func,
        embedding_func=embedding_func,
        kv_storage="PGKVStorage",
        doc_status_storage="PGDocStatusStorage",
        graph_storage="Neo4JStorage",
        vector_storage="PGVectorStorage",
        vector_db_storage_cls_kwargs={"cosine_better_than_threshold": 0.4},
    )

    await _app.state.rag.initialize_storages()
    await (
        initialize_pipeline_status()
    )  # This function is called during FASTAPI lifespan for each worker.
    logger.info("RAG object has been initialized")

    try:
        await seed_default_languages()
        logger.info("Languages seeded")
    except Exception:  # pragma: no cover - startup logging only
        logger.exception("Failed to seed languages during startup")

    try:
        await seed_default_verification_topics()
        logger.info("Verification topics seeded")
    except Exception:  # pragma: no cover - startup logging only
        logger.exception("Failed to seed verification topics during startup")

    yield
    # shutdown
    logger.info("shutting down server")


docs_url = None
if SERVE_API_DOCS:
    logger.info("serving api docs at /docs")
    docs_url = "/docs"

# cors: protected by default, use DISABLE_CORS to disable
origins = "*" if DISABLE_CORS else [ADMIN_BASE_URL, PARTICIPANT_BASE_URL]

logger.info(f"CORS origins: {origins}")

middleware = [
    Middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "OPTIONS", "PUT", "DELETE"],
        allow_headers=["*"],
        expose_headers=["*"],
        max_age=86400,
    )
]

app = FastAPI(lifespan=lifespan, docs_url=docs_url, redoc_url=None, middleware=middleware)


@app.middleware("http")
async def add_process_time_header(request: Request, call_next):  # type: ignore
    start_time = time.time()
    response = await call_next(request)
    process_time = time.time() - start_time
    response.headers["X-Process-Time"] = str(process_time)
    return response


logger.info("mounting api on /api")
app.include_router(api, prefix="/api")


class SPAStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope):  # type: ignore
        try:
            return await super().get_response(path, scope)
        except (HTTPException, StarletteHTTPException) as ex:
            if ex.status_code == 404:
                return await super().get_response("index.html", scope)
            else:
                raise ex


def custom_openapi() -> Any:
    if app.openapi_schema:
        return app.openapi_schema
    openapi_schema = get_openapi(
        title="dembrane/echo API",
        version="1.0.0",
        routes=app.routes,
    )
    openapi_schema["info"]["x-logo"] = {"url": "/dembrane-logo.png"}
    app.openapi_schema = openapi_schema
    return app.openapi_schema


app.openapi = custom_openapi  # type: ignore


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
