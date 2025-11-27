"""
Custom Uvicorn worker for Gunicorn that forces asyncio loop.
"""

from uvicorn.workers import UvicornWorker


class AsyncioUvicornWorker(UvicornWorker):
    """
    Uvicorn worker that uses asyncio instead of uvloop.
    
    Usage with gunicorn:
        gunicorn dembrane.main:app \
            --worker-class dembrane.gunicorn_worker.AsyncioUvicornWorker \
            --workers 2 \
            --bind 0.0.0.0:8000
    """
    
    CONFIG_KWARGS = {
        **UvicornWorker.CONFIG_KWARGS,
        "loop": "asyncio",
        "http": "auto",
    }

