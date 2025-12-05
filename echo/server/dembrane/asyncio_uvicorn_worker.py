"Use asyncio loop instead of uvloop for compatibility with nest_asyncio"

from uvicorn.workers import UvicornWorker


class AsyncioUvicornWorker(UvicornWorker):
    CONFIG_KWARGS = {"loop": "asyncio"}
