"""Gzip for JSON, passthrough for SSE.

Uses httpx.AsyncClient + ASGITransport (not starlette.testclient.TestClient):
this repo pins httpx==0.28.1, which dropped the `app=` shortcut that
starlette 0.36.3's TestClient still relies on internally, so TestClient
raises TypeError here. See tests/api/test_bff_memory.py for the same pattern.
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from starlette.middleware import Middleware

from dembrane.gzip_middleware import SSEAwareGZipMiddleware


def _app() -> FastAPI:
    app = FastAPI(middleware=[Middleware(SSEAwareGZipMiddleware, minimum_size=64)])

    @app.get("/big")
    def big() -> dict:
        return {"data": "x" * 4096}

    @app.get("/sse")
    def sse() -> StreamingResponse:
        def gen():
            yield "data: hello\n\n"
            yield "data: world\n\n"

        return StreamingResponse(gen(), media_type="text/event-stream")

    return app


@pytest.mark.asyncio
async def test_json_is_gzipped() -> None:
    transport = ASGITransport(app=_app())
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        res = await client.get("/big", headers={"Accept-Encoding": "gzip"})
    assert res.headers.get("content-encoding") == "gzip"
    assert res.json()["data"] == "x" * 4096


@pytest.mark.asyncio
async def test_sse_is_not_gzipped() -> None:
    transport = ASGITransport(app=_app())
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        async with client.stream("GET", "/sse", headers={"Accept-Encoding": "gzip"}) as res:
            assert res.headers.get("content-encoding") is None
            body = b"".join([chunk async for chunk in res.aiter_raw()])
    assert b"data: hello" in body and b"data: world" in body


@pytest.mark.asyncio
async def test_no_gzip_without_accept_encoding() -> None:
    transport = ASGITransport(app=_app())
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        res = await client.get("/big", headers={"Accept-Encoding": "identity"})
    assert res.headers.get("content-encoding") is None
