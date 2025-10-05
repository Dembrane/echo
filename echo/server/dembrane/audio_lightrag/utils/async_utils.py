"""
Utilities for safely executing async code from sync contexts (e.g., Dramatiq workers).

This module solves the "Task got Future attached to a different loop" errors
that occur when mixing sync Dramatiq tasks with async LightRAG code.
"""
import asyncio
import logging
import threading
from typing import Any, TypeVar, Coroutine

logger = logging.getLogger(__name__)

T = TypeVar("T")

# One persistent event loop per thread
_thread_loops: dict[int, asyncio.AbstractEventLoop] = {}
_thread_loops_lock = threading.Lock()


def get_thread_event_loop() -> asyncio.AbstractEventLoop:
    """
    Get or create a persistent event loop for the current thread.
    
    Each worker thread gets ONE event loop that persists across all tasks.
    This matches the architecture of FastAPI/Uvicorn where the API server
    has one persistent loop.
    
    Benefits:
    - RAGManager's per-loop instances work correctly
    - LightRAG's ClientManager lock stays bound to the same loop
    - No loop creation/destruction overhead per task
    - Resources (DB pools, HTTP clients) persist and get reused
    
    Returns:
        The persistent event loop for this thread
    """
    thread_id = threading.get_ident()
    
    # Fast path: loop already exists for this thread
    if thread_id in _thread_loops:
        return _thread_loops[thread_id]
    
    # Slow path: create new loop (thread-safe)
    with _thread_loops_lock:
        # Double-check after acquiring lock
        if thread_id in _thread_loops:
            return _thread_loops[thread_id]
        
        # Create and register new loop for this thread
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        _thread_loops[thread_id] = loop
        
        logger.info(f"Created persistent event loop for thread {thread_id}")
        return loop


def run_async_in_new_loop(coro: Coroutine[Any, Any, T]) -> T:
    """
    Execute an async coroutine in this thread's persistent event loop.
    
    This is the recommended way to call async code from sync Dramatiq tasks.
    Uses a persistent event loop per thread instead of creating/destroying
    loops for each task.
    
    Args:
        coro: The coroutine to execute
        
    Returns:
        The result of the coroutine
        
    Example:
        ```python
        @dramatiq.actor
        def task_run_etl_pipeline(conversation_id: str):
            # This is sync, but contextual_pipeline.load() is async
            result = run_async_in_new_loop(
                contextual_pipeline.load()
            )
        ```
    
    Why this works:
    - Uses one persistent loop per worker thread (like API server)
    - RAGManager creates one instance per loop (thread isolation)
    - LightRAG's ClientManager lock stays bound to same loop
    - Safe for concurrent Dramatiq workers (each has own loop)
    """
    loop = get_thread_event_loop()
    
    logger.debug(f"Running async coroutine in thread loop: {coro}")
    result = loop.run_until_complete(coro)
    logger.debug(f"Successfully completed async coroutine: {coro}")
    
    return result


def run_async_safely(coro: Coroutine[Any, Any, T]) -> T:
    """
    Alias for run_async_in_new_loop for backwards compatibility.
    """
    return run_async_in_new_loop(coro)
