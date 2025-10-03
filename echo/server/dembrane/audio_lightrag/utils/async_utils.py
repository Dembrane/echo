"""
Utilities for safely executing async code from sync contexts (e.g., Dramatiq workers).

This module solves the "Task got Future attached to a different loop" errors
that occur when mixing sync Dramatiq tasks with async LightRAG code.
"""
import asyncio
import logging
from typing import TypeVar, Coroutine, Any

logger = logging.getLogger(__name__)

T = TypeVar("T")


def run_async_in_new_loop(coro: Coroutine[Any, Any, T]) -> T:
    """
    Execute an async coroutine in a fresh event loop.
    
    This is the recommended way to call async code from sync Dramatiq tasks.
    It creates a completely isolated event loop to avoid "Future attached to
    different loop" errors.
    
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
    - Creates a fresh event loop that exists only for this task
    - No mixing of loops or futures between different tasks
    - Closes the loop when done to free resources
    - Safe for concurrent Dramatiq workers
    """
    # Create a brand new event loop just for this coroutine
    loop = asyncio.new_event_loop()
    
    try:
        # Set it as the current event loop for this thread
        asyncio.set_event_loop(loop)
        
        # Run the coroutine to completion
        logger.debug(f"Running async coroutine in new loop: {coro}")
        result = loop.run_until_complete(coro)
        
        logger.debug(f"Successfully completed async coroutine: {coro}")
        return result
        
    finally:
        # Clean up: close the loop to free resources
        try:
            # Cancel any remaining tasks
            pending = asyncio.all_tasks(loop)
            for task in pending:
                task.cancel()
            
            # Wait for all tasks to finish cancelling
            if pending:
                loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            
            # Close the loop
            loop.close()
            logger.debug("Closed event loop successfully")
            
        except Exception as e:
            logger.warning(f"Error while closing event loop: {e}")


def run_async_safely(coro: Coroutine[Any, Any, T]) -> T:
    """
    Alias for run_async_in_new_loop for backwards compatibility.
    """
    return run_async_in_new_loop(coro)
