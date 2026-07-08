"""
Async helper utilities for wrapping blocking I/O operations in thread pools.

This module provides utilities to run synchronous blocking operations (DB queries, S3 calls,
HTTP requests) in a thread pool, preventing them from blocking the main event loop.

Key features:
- Configurable thread pool size via THREAD_POOL_SIZE environment variable (default: 64)
- Clean API for wrapping blocking calls
- Persistent event loops per thread for Dramatiq workers

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
import contextvars
from typing import Any, TypeVar, Callable, Optional, Coroutine
from logging import getLogger
from functools import partial
from concurrent.futures import ThreadPoolExecutor

logger = getLogger("async_helpers")

T = TypeVar("T")

# ContextVar to track the event loop created by run_async_in_new_loop().
# Under dramatiq-gevent, multiple greenlets share one OS thread, so
# asyncio's thread-local _running_loop can be corrupted when greenlets
# interleave. This ContextVar provides a reliable fallback because
# contextvars are properly inherited by asyncio Tasks via copy_context().
_worker_loop: contextvars.ContextVar[Optional[asyncio.AbstractEventLoop]] = contextvars.ContextVar(
    "_worker_loop", default=None
)

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
                    lambda: (
                        _thread_pool_executor.shutdown(wait=True)
                        if _thread_pool_executor is not None
                        else None
                    )
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

    # In Dramatiq workers (gevent), the thread-local _running_loop
    # can be corrupted by greenlet interleaving. Prefer the ContextVar
    # which is reliably inherited by asyncio Tasks via copy_context().
    loop = _worker_loop.get(None)
    if loop is not None and not loop.is_closed():
        pass  # use the reliable ContextVar value
    else:
        loop = asyncio.get_running_loop()  # FastAPI path (ContextVar is None)

    # If there are kwargs, use partial to bind them
    if kwargs:
        func = partial(func, **kwargs)

    # Run in thread pool executor
    # Note: We use the global thread pool instead of None (default) to ensure
    # we have control over the thread count via environment variable
    return await loop.run_in_executor(get_thread_pool_executor(), func, *args)


def _get_worker_loop() -> asyncio.AbstractEventLoop:
    """
    Get the correct event loop, preferring the ContextVar over the thread-local.

    Under dramatiq-gevent, multiple greenlets share one OS thread. asyncio's
    thread-local _running_loop can be corrupted when greenlets interleave
    (e.g., another greenlet's run_async_in_new_loop overwrites it). The
    _worker_loop ContextVar is reliable because asyncio Tasks snapshot
    contextvars at creation time via copy_context().

    Falls back to asyncio.get_running_loop() for the FastAPI path where
    _worker_loop is None.
    """
    loop = _worker_loop.get(None)
    if loop is not None and not loop.is_closed():
        return loop
    return asyncio.get_running_loop()


async def safe_gather(*coros_or_futures: Any, return_exceptions: bool = False) -> list:
    """
    Like asyncio.gather but resistant to gevent greenlet interleaving.

    asyncio.gather internally calls get_running_loop() (a thread-local) to
    create tasks from coroutines. Under dramatiq-gevent, this thread-local
    can point to another greenlet's (now-closed) event loop, causing
    "Event loop is closed" errors.

    This helper pre-creates Task objects on the correct loop (from the
    _worker_loop ContextVar) before passing them to asyncio.gather, which
    then just gathers already-created futures without needing get_running_loop().
    """
    loop = _get_worker_loop()
    tasks = [loop.create_task(c) if asyncio.iscoroutine(c) else c for c in coros_or_futures]
    return await asyncio.gather(*tasks, return_exceptions=return_exceptions)


# Persistent event loops per worker thread for Dramatiq actors
_thread_loops: dict[int, asyncio.AbstractEventLoop] = {}
_thread_loops_lock = threading.Lock()


def _get_thread_event_loop() -> asyncio.AbstractEventLoop:
    """
    Fetch or create the persistent event loop for the current thread.
    Used by Dramatiq actors to run async code in sync contexts.
    """
    thread_id = threading.get_ident()

    if thread_id in _thread_loops:
        return _thread_loops[thread_id]

    with _thread_loops_lock:
        if thread_id in _thread_loops:
            return _thread_loops[thread_id]

        import nest_asyncio

        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        nest_asyncio.apply(loop)
        _thread_loops[thread_id] = loop
        logger.info("Created persistent event loop for thread %s", thread_id)
        return loop


# ---------------------------------------------------------------------------
# Shared background event loop for running async code from sync contexts.
#
# Dramatiq actors (and CLI scripts) are synchronous but must call async code
# (the async Directus client, LLM helpers, etc.). The previous approach created
# a *fresh* event loop on every call and closed it immediately. That:
#   * orphaned the connection pool of long-lived httpx.AsyncClient singletons
#     (e.g. async_directus) -> RuntimeError("Event loop is closed"), and
#   * under dramatiq-gevent, broke sniffio's async-library detection
#     -> sniffio.AsyncLibraryNotFoundError,
# so task_summarize_conversation / task_merge_conversation_chunks failed on
# every run.
#
# Instead we run ONE asyncio loop for the lifetime of the process in a
# dedicated *real* OS thread and submit coroutines to it. Because the loop
# never closes, httpx clients bind to it once and keep pooling, and sniffio
# sees a genuinely running asyncio loop (no nest_asyncio required). The loop
# must live on a real OS thread (not a gevent greenlet) so its selector blocks
# only that thread, never the gevent hub; gevent (>=25) cooperatively yields
# while a greenlet waits on the cross-thread Future.
# ---------------------------------------------------------------------------
_bg_loop: Optional[asyncio.AbstractEventLoop] = None
_bg_loop_thread: Optional[threading.Thread] = None
_bg_loop_lock = threading.Lock()


def _real_thread_class() -> "type[threading.Thread]":
    """Return a true OS-thread class even when gevent has monkey-patched threading."""
    try:
        from gevent.monkey import get_original

        return get_original("threading", "Thread")
    except Exception:
        return threading.Thread


def _is_gevent_patched() -> bool:
    """True when gevent has monkey-patched the runtime (i.e. the dramatiq-gevent worker)."""
    try:
        from gevent import monkey

        return bool(monkey.is_anything_patched())
    except Exception:
        return False


def _ensure_background_loop() -> asyncio.AbstractEventLoop:
    """Get (or lazily start) the shared background event loop."""
    global _bg_loop, _bg_loop_thread
    if (
        _bg_loop is not None
        and not _bg_loop.is_closed()
        and _bg_loop.is_running()
        and (_bg_loop_thread is None or _bg_loop_thread.is_alive())
    ):
        return _bg_loop
    with _bg_loop_lock:
        if (
            _bg_loop is not None
            and not _bg_loop.is_closed()
            and _bg_loop.is_running()
            and (_bg_loop_thread is None or _bg_loop_thread.is_alive())
        ):
            return _bg_loop

        _stop_background_loop_locked("background loop was not healthy")

        loop = asyncio.new_event_loop()
        ready = threading.Event()

        def _runner() -> None:
            asyncio.set_event_loop(loop)
            loop.call_soon(ready.set)
            loop.run_forever()

        thread = _real_thread_class()(target=_runner, name="dembrane-async-loop", daemon=True)
        thread.start()
        ready.wait()
        _bg_loop = loop
        _bg_loop_thread = thread
        logger.info("Started shared background event loop on thread %s", thread.name)
        return loop


def _stop_background_loop_locked(reason: str) -> None:
    """Stop and forget the shared background loop. Caller must hold _bg_loop_lock."""
    global _bg_loop, _bg_loop_thread

    loop = _bg_loop
    thread = _bg_loop_thread
    _bg_loop = None
    _bg_loop_thread = None

    if loop is None:
        return

    logger.warning("Resetting shared background event loop: %s", reason)
    if not loop.is_closed():
        if loop.is_running():
            loop.call_soon_threadsafe(loop.stop)
        if thread is not None and thread.is_alive():
            thread.join(timeout=5)
        if not loop.is_running():
            loop.close()


def reset_background_loop(reason: str) -> None:
    """Force the shared background loop to be recreated on the next async call."""
    with _bg_loop_lock:
        _stop_background_loop_locked(reason)


def _is_async_library_not_found(exc: BaseException) -> bool:
    """Return True if exc or its causal chain is sniffio's async-library failure."""
    from sniffio import AsyncLibraryNotFoundError

    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        if isinstance(current, AsyncLibraryNotFoundError):
            return True
        seen.add(id(current))
        current = current.__cause__ or current.__context__
    return False


def _reset_async_runtime_for_retry(reason: str) -> None:
    """Discard async clients and force the shared loop to be recreated."""
    try:
        from dembrane.directus_async import async_directus

        discarded = async_directus.reset_clients()
        logger.warning("Discarded %s async Directus client(s) during recovery", discarded)
    except Exception:
        logger.exception("Failed to discard async Directus clients during recovery")

    reset_background_loop(reason)


def _run_async_once(awaitable: Coroutine[Any, Any, T] | asyncio.Future[T]) -> T:
    if not asyncio.iscoroutine(awaitable) and not asyncio.isfuture(awaitable):
        raise TypeError("run_async_in_new_loop expects a coroutine, Future, or zero-arg factory.")

    if not _is_gevent_patched():
        try:
            running_loop: Optional[asyncio.AbstractEventLoop] = asyncio.get_running_loop()
        except RuntimeError:
            running_loop = None

        if running_loop is not None:
            # Inside a real running loop (FastAPI): run nested to avoid deadlocking it.
            import nest_asyncio

            nest_asyncio.apply(running_loop)
            return running_loop.run_until_complete(awaitable)

    loop = _ensure_background_loop()
    if asyncio.iscoroutine(awaitable):
        future = asyncio.run_coroutine_threadsafe(awaitable, loop)
    else:
        # A bare Future/awaitable: adapt it onto the background loop.
        async def _await_it() -> T:
            return await awaitable

        future = asyncio.run_coroutine_threadsafe(_await_it(), loop)
    return future.result()


def run_async_in_new_loop(
    coro: Coroutine[Any, Any, T]
    | asyncio.Future[T]
    | Callable[[], Coroutine[Any, Any, T] | asyncio.Future[T]],
) -> T:
    """
    Run an async coroutine to completion from a synchronous context.

    Use from Dramatiq actors or CLI scripts to invoke async code (async FastAPI
    handlers, the async Directus client, LLM helpers, etc.).

    The coroutine runs on a single long-lived background event loop (see
    _ensure_background_loop); the calling thread/greenlet blocks on the result.

    When called from *within* an already-running loop on the FastAPI (asyncio
    uvicorn) server we fall back to nested execution on that loop via
    nest_asyncio, preserving the previous behavior for that path.

    Under dramatiq-gevent we must NOT use that fallback: asyncio's running-loop
    is thread-local and shared across greenlets, so get_running_loop() can return
    a loop that a *different* greenlet is driving. Taking the nested path then
    drives a foreign/contended loop and the actor hangs until TimeLimitExceeded.
    In the gevent worker we always use the dedicated background loop (its own OS
    thread), which is immune to greenlet interleaving.

    Pass a zero-arg coroutine factory when the work may be retried. Coroutine
    objects are consumed after their first await, so only factory inputs can be
    retried on sniffio.AsyncLibraryNotFoundError.
    """
    is_factory = callable(coro) and not asyncio.iscoroutine(coro) and not asyncio.isfuture(coro)
    attempts = 2 if is_factory else 1

    for attempt in range(attempts):
        awaitable = coro() if is_factory else coro
        try:
            return _run_async_once(awaitable)
        except Exception as exc:
            if not _is_async_library_not_found(exc):
                raise
            if attempt + 1 >= attempts:
                logger.exception(
                    "sniffio AsyncLibraryNotFoundError crossed run_async_in_new_loop; "
                    "resetting async runtime without retry because no fresh coroutine "
                    "factory is available"
                )
                _reset_async_runtime_for_retry(
                    "sniffio AsyncLibraryNotFoundError in run_async_in_new_loop"
                )
                raise
            logger.exception(
                "sniffio AsyncLibraryNotFoundError crossed run_async_in_new_loop; "
                "resetting async clients/background loop and retrying once"
            )
            _reset_async_runtime_for_retry(
                "sniffio AsyncLibraryNotFoundError in run_async_in_new_loop"
            )

    raise RuntimeError("unreachable run_async_in_new_loop retry state")
