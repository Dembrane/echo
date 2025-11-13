import time
from typing import Any, Callable, Awaitable, AsyncGenerator
from logging import getLogger
from contextlib import asynccontextmanager

import nest_asyncio
from fastapi import FastAPI, Request, HTTPException
from starlette.types import Scope
from fastapi.staticfiles import StaticFiles
from starlette.responses import Response
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware import Middleware
from fastapi.openapi.utils import get_openapi
from starlette.middleware.cors import CORSMiddleware

from dembrane.seed import seed_default_languages, seed_default_verification_topics
from dembrane.sentry import init_sentry
from dembrane.api.api import api
from dembrane.settings import get_settings

# LightRAG requires nest_asyncio for nested event loops
nest_asyncio.apply()

logger = getLogger("server")
settings = get_settings()
DISABLE_CORS = settings.feature_flags.disable_cors
ADMIN_BASE_URL = str(settings.urls.admin_base_url)
PARTICIPANT_BASE_URL = str(settings.urls.participant_base_url)
SERVE_API_DOCS = settings.feature_flags.serve_api_docs


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncGenerator[None, None]:
    # startup
    logger.info("starting server")
    init_sentry()

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
async def add_process_time_header(
    request: Request,
    call_next: Callable[[Request], Awaitable[Response]],
) -> Response:
    start_time = time.time()
    response = await call_next(request)
    process_time = time.time() - start_time
    response.headers["X-Process-Time"] = str(process_time)
    return response


logger.info("mounting api on /api")
app.include_router(api, prefix="/api")


class SPAStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope: Scope) -> Response:
        try:
            return await super().get_response(path, scope)
        except (HTTPException, StarletteHTTPException) as ex:
            if ex.status_code == 404:
                return await super().get_response("index.html", scope)
            else:
                raise ex


def custom_openapi() -> dict[str, Any]:
    if app.openapi_schema:
        return app.openapi_schema
    openapi_schema = get_openapi(
        title="dembrane/echo API",
        version="1.0.0",
        routes=app.routes,
    )
    openapi_schema["info"]["x-logo"] = {"url": "/dembrane-logo.png"}
    app.openapi_schema = openapi_schema
    return openapi_schema


app.openapi = custom_openapi


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
