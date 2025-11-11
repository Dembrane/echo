"""
Async helper utilities for wrapping blocking I/O operations in thread pools.

This module provides utilities to run synchronous blocking operations (DB queries, S3 calls,
HTTP requests) in a thread pool, preventing them from blocking the main event loop.

Key features:
- Configurable thread pool size via THREAD_POOL_SIZE environment variable (default: 64)
- Clean API for wrapping blocking calls
- Safe for use with LightRAG (keeps RAG operations on main loop)

Usage:
    from dembrane.async_helpers import run_in_thread_pool

    # Simple function call
    result = await run_in_thread_pool(blocking_function, arg1, arg2)

    # Function with keyword arguments
    result = await run_in_thread_pool(blocking_function, arg1, kwarg1=value, kwarg2=value)
"""

import os
import atexit
import asyncio
import threading
from typing import Any, TypeVar, Callable, Optional, Awaitable, Coroutine
from logging import getLogger
from functools import partial
from concurrent.futures import ThreadPoolExecutor

logger = getLogger("async_helpers")

T = TypeVar("T")

# Get thread pool size from environment or use default
try:
    THREAD_POOL_SIZE = int(os.getenv("THREAD_POOL_SIZE", "64"))
    THREAD_POOL_SIZE = max(1, min(THREAD_POOL_SIZE, 1024))
except (TypeError, ValueError):
    THREAD_POOL_SIZE = 64
    logger.warning("Invalid THREAD_POOL_SIZE; defaulting to 64")

# Create a single ThreadPoolExecutor for the entire application
# This will be initialized lazily on first use
_thread_pool_executor: Optional[ThreadPoolExecutor] = None
_executor_lock = threading.Lock()


def get_thread_pool_executor() -> ThreadPoolExecutor:
    """
    Get or create the global ThreadPoolExecutor.

    This is lazily initialized to ensure it's created after the event loop starts.
    Thread-safe initialization using a lock.
    """
    global _thread_pool_executor
    if _thread_pool_executor is None:
        with _executor_lock:
            # Double-check pattern: another thread might have initialized it
            if _thread_pool_executor is None:
                _thread_pool_executor = ThreadPoolExecutor(
                    max_workers=THREAD_POOL_SIZE, thread_name_prefix="blocking_io"
                )
                logger.info(f"Initialized ThreadPoolExecutor with {THREAD_POOL_SIZE} threads")
                # Ensure clean shutdown on process exit
                atexit.register(
                    lambda: _thread_pool_executor.shutdown(wait=True)
                    if _thread_pool_executor is not None
                    else None
                )
    return _thread_pool_executor


async def run_in_thread_pool(func: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    """
    Run a blocking function in the default thread pool.

    This prevents blocking I/O operations from freezing the event loop,
    allowing the async application to handle many concurrent requests.

    Args:
        func: The blocking function to execute (must be synchronous, not async)
        *args: Positional arguments to pass to the function
        **kwargs: Keyword arguments to pass to the function

    Returns:
        The result of the blocking function

    Raises:
        TypeError: If an async function or coroutine is passed

    Example:
        # Database query
        conversation = await run_in_thread_pool(
            conversation_service.get_by_id_or_raise,
            conversation_id
        )

        # S3 operation with kwargs
        file_size = await run_in_thread_pool(
            get_file_size_bytes_from_s3,
            file_key
        )

        # Function with multiple kwargs
        presigned_data = await run_in_thread_pool(
            generate_presigned_post,
            file_name=file_key,
            content_type="audio/webm",
            size_limit_mb=2048,
            expires_in_seconds=3600
        )

    Important:
        - DO NOT use this for LightRAG operations (rag.aquery, rag.ainsert, etc.)
        - Only use for truly blocking I/O (DB queries, S3 calls, HTTP with requests library)
        - Already-async functions should be awaited directly, not wrapped
        - This helper only accepts synchronous functions
    """
    # Guard against async callables
    if asyncio.iscoroutinefunction(func):
        raise TypeError(
            f"run_in_thread_pool received an async function '{func.__name__}'. "
            "Async functions should be awaited directly, not wrapped in a thread pool."
        )

    if asyncio.iscoroutine(func):
        raise TypeError(
            "run_in_thread_pool received a coroutine object. "
            "Coroutines should be awaited directly, not wrapped in a thread pool."
        )

    loop = asyncio.get_running_loop()

    # If there are kwargs, use partial to bind them
    if kwargs:
        func = partial(func, **kwargs)

    # Run in thread pool executor
    # Note: We use the global thread pool instead of None (default) to ensure
    # we have control over the thread count via environment variable
    return await loop.run_in_executor(get_thread_pool_executor(), func, *args)


# Persistent event loops per worker thread for LightRAG compatibility
_thread_loops: dict[int, asyncio.AbstractEventLoop] = {}
_thread_loops_lock = threading.Lock()


def _get_thread_event_loop() -> asyncio.AbstractEventLoop:
    """
    Fetch or create the persistent event loop for the current thread.
    Mirrors the previous dembrane.audio_lightrag.utils.async_utils implementation
    so LightRAG objects tied to an event loop (e.g., RAGManager) continue to work.
    """
    thread_id = threading.get_ident()

    if thread_id in _thread_loops:
        return _thread_loops[thread_id]

    with _thread_loops_lock:
        if thread_id in _thread_loops:
            return _thread_loops[thread_id]

        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        _thread_loops[thread_id] = loop
        logger.info("Created persistent event loop for thread %s", thread_id)
        return loop


def run_async_in_new_loop(coro: Coroutine[Any, Any, T]) -> T:
    """
    Execute an async coroutine on this thread's persistent event loop.

    Use from synchronous contexts such as Dramatiq actors or CLI scripts to
    invoke async FastAPI handlers / LightRAG routines without hitting
    "Future attached to a different loop" errors.
    """
    if not asyncio.iscoroutine(coro) and not asyncio.isfuture(coro):
        raise TypeError("run_async_in_new_loop expects a coroutine or Future.")

    loop = _get_thread_event_loop()
    logger.debug("Running async coroutine in thread loop: %s", coro)
    result = loop.run_until_complete(coro)
    logger.debug("Completed async coroutine: %s", coro)
    return result
