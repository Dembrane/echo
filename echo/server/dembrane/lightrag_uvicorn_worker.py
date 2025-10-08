"""LightRAG-compatible Uvicorn worker for Gunicorn with asyncio loop support.

LightRAG uses asyncio.run() in its codebase, which requires nest_asyncio to handle
nested event loops. However, nest_asyncio cannot patch uvloop (Uvicorn's default).

This worker uses the standard asyncio loop instead of uvloop, allowing nest_asyncio
to properly patch the event loop and support LightRAG's synchronous wrapper functions.

Performance note: uvloop is ~10-20% faster than asyncio, but this overhead is
negligible compared to LLM and database I/O operations.
"""

from uvicorn.workers import UvicornWorker


class LightRagUvicornWorker(UvicornWorker):
    """Uvicorn worker configured to use asyncio instead of uvloop for LightRAG compatibility."""

    CONFIG_KWARGS = {"loop": "asyncio"}
