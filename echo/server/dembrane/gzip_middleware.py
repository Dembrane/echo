"""GZip middleware that leaves SSE streams untouched.

Starlette 0.36.3's GZipMiddleware gzips streaming responses without
flushing per chunk, which buffers text/event-stream events until the
gzip window fills. Marking the responder's passthrough flag on SSE
responses makes it forward those untouched.

UPGRADE PATH: Starlette 0.46.0 fixed this upstream (PR #2871, "don't
compress on server sent events"). When fastapi is bumped past its
starlette<0.37 pin, DELETE this module and register the stock
GZipMiddleware in main.py; keep tests/test_gzip_middleware.py as the
behavior contract (only the zip passthrough needs a decision: stock
does not exclude application/zip, which is CPU waste, not a bug).
This subclass touches GZipResponder internals and must not survive a
starlette upgrade.
"""

from __future__ import annotations

from starlette.types import Send, Scope, ASGIApp, Message, Receive
from starlette.datastructures import Headers
from starlette.middleware.gzip import GZipResponder, GZipMiddleware

# SSE must not be buffered by the gzip window; zip is already compressed.
# Add any future incrementally-streamed content type here (e.g. NDJSON /
# application/x-ndjson) or it will silently buffer behind the gzip window.
_PASSTHROUGH_CONTENT_TYPES = ("text/event-stream", "application/zip")


class _SSEAwareGZipResponder(GZipResponder):
    async def send_with_gzip(self, message: Message) -> None:
        if message["type"] == "http.response.start":
            headers = Headers(raw=message["headers"])
            content_type = headers.get("content-type", "")
            passthrough = content_type.startswith(_PASSTHROUGH_CONTENT_TYPES)
            # base class sets content_encoding_set from real headers here, so
            # our override must run after it or it gets clobbered back to False.
            await super().send_with_gzip(message)
            if passthrough:
                # content_encoding_set triggers the responder's passthrough path.
                self.content_encoding_set = True
        else:
            await super().send_with_gzip(message)


class SSEAwareGZipMiddleware(GZipMiddleware):
    def __init__(self, app: ASGIApp, minimum_size: int = 1024, compresslevel: int = 6) -> None:
        super().__init__(app, minimum_size=minimum_size, compresslevel=compresslevel)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            headers = Headers(scope=scope)
            if "gzip" in headers.get("Accept-Encoding", ""):
                responder = _SSEAwareGZipResponder(
                    self.app, self.minimum_size, compresslevel=self.compresslevel
                )
                await responder(scope, receive, send)
                return
        await self.app(scope, receive, send)
