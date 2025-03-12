import os
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
from lightrag.kg.postgres_impl import PostgreSQLDB
from lightrag.llm.azure_openai import azure_openai_complete
from starlette.middleware.cors import CORSMiddleware

from dembrane.config import (
    ADMIN_BASE_URL,
    SERVE_API_DOCS,
    PARTICIPANT_BASE_URL,
)
from dembrane.sentry import init_sentry
from dembrane.api.api import api
from dembrane.audio_lightrag.utils.lightrag_utils import embedding_func, check_audio_lightrag_tables

nest_asyncio.apply()

logger = getLogger("server")
print('**********', os.environ.get("NEO4J_USERNAME"))

@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncGenerator[None, None]:
    # startup
    logger.info("starting server")
    init_sentry()
    
    # Initialize PostgreSQL and LightRAG
    postgres_config = {
        "host": os.environ["POSTGRES_HOST"],
        "port": os.environ["POSTGRES_PORT"],
        "user": os.environ["POSTGRES_USER"],
        "password": os.environ["POSTGRES_PASSWORD"],
        "database": os.environ["POSTGRES_DATABASE"],
        # "workspace": os.environ["POSTGRES_WORKSPACE"]
    }

    postgres_db = PostgreSQLDB(config=postgres_config)
    await postgres_db.initdb()
    await postgres_db.check_tables()
    await check_audio_lightrag_tables(postgres_db)

    working_dir = os.environ["POSTGRES_WORK_DIR"]
    if not os.path.exists(working_dir):
        os.makedirs(working_dir)

    _app.state.rag = LightRAG(
        working_dir=working_dir,
        llm_model_func=azure_openai_complete,
        embedding_func=embedding_func,
        kv_storage="PGKVStorage",
        doc_status_storage="PGDocStatusStorage",
        graph_storage="Neo4JStorage",
        vector_storage="PGVectorStorage",
        vector_db_storage_cls_kwargs={
            "cosine_better_than_threshold": 0.7
        }
    )
    
    logger.info("RAG object has been initialized")

    yield
    # shutdown
    logger.info("shutting down server")


docs_url = None
if SERVE_API_DOCS:
    logger.info("serving api docs at /docs")
    docs_url = "/docs"

# need to be added at the end
origins = [
    ADMIN_BASE_URL,
    PARTICIPANT_BASE_URL,
]

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
        title="dembrane/pilot API",
        version="0.2.0",
        routes=app.routes,
    )
    openapi_schema["info"]["x-logo"] = {"url": "/dembrane-logo.png"}
    app.openapi_schema = openapi_schema
    return app.openapi_schema


app.openapi = custom_openapi  # type: ignore


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
