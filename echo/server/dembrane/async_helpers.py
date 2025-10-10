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
import asyncio
from typing import TypeVar, Callable, Any
from functools import partial
from logging import getLogger

logger = getLogger("async_helpers")

T = TypeVar('T')

# Get thread pool size from environment or use default
THREAD_POOL_SIZE = int(os.getenv("THREAD_POOL_SIZE", "64"))

# Create a single ThreadPoolExecutor for the entire application
# This will be initialized lazily on first use
_thread_pool_executor = None


def get_thread_pool_executor():
    """
    Get or create the global ThreadPoolExecutor.
    
    This is lazily initialized to ensure it's created after the event loop starts.
    """
    global _thread_pool_executor
    if _thread_pool_executor is None:
        from concurrent.futures import ThreadPoolExecutor
        _thread_pool_executor = ThreadPoolExecutor(
            max_workers=THREAD_POOL_SIZE,
            thread_name_prefix="blocking_io"
        )
        logger.info(f"Initialized ThreadPoolExecutor with {THREAD_POOL_SIZE} threads")
    return _thread_pool_executor


async def run_in_thread_pool(func: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    """
    Run a blocking function in the default thread pool.
    
    This prevents blocking I/O operations from freezing the event loop,
    allowing the async application to handle many concurrent requests.
    
    Args:
        func: The blocking function to execute
        *args: Positional arguments to pass to the function
        **kwargs: Keyword arguments to pass to the function
        
    Returns:
        The result of the blocking function
        
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
    """
    loop = asyncio.get_running_loop()
    
    # If there are kwargs, use partial to bind them
    if kwargs:
        func = partial(func, **kwargs)
    
    # Run in thread pool executor
    # Note: We use the global thread pool instead of None (default) to ensure
    # we have control over the thread count via environment variable
    return await loop.run_in_executor(get_thread_pool_executor(), func, *args)
