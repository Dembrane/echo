"use asyncio loop instead of uvloop. historically used for LightRAG compatibility"

from uvicorn.workers import UvicornWorker


class AsyncioUvicornWorker(UvicornWorker):
    CONFIG_KWARGS = {"loop": "asyncio"}
