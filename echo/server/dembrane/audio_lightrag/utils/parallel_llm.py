"""
Parallel LLM call utilities with rate limiting.

Enables processing multiple segments concurrently while respecting API rate limits.
"""
import time
import asyncio
import logging
from typing import Any, List, Callable, Optional, Coroutine

logger = logging.getLogger(__name__)


class RateLimitedExecutor:
    """
    Execute async tasks in parallel with rate limiting.
    
    This allows us to process multiple LLM requests concurrently while staying
    within API rate limits (e.g., OpenAI: 10,000 RPM, Claude: 4,000 RPM).
    """
    
    def __init__(
        self,
        max_concurrent: int = 10,
        requests_per_minute: Optional[int] = None,
        delay_between_batches: float = 0.0
    ):
        """
        Initialize rate-limited executor.
        
        Args:
            max_concurrent: Maximum concurrent requests
            requests_per_minute: Rate limit (None = no limit)
            delay_between_batches: Delay in seconds between batches
        """
        self.max_concurrent = max_concurrent
        self.requests_per_minute = requests_per_minute
        self.delay_between_batches = delay_between_batches
        
        # Calculate minimum delay between requests if rate limit specified
        if requests_per_minute:
            self.min_request_delay = 60.0 / requests_per_minute
        else:
            self.min_request_delay = 0.0
        
        self.semaphore = asyncio.Semaphore(max_concurrent)
        self.last_request_time = 0.0
        self.request_lock = asyncio.Lock()
    
    async def _rate_limited_call(self, coro: Coroutine) -> Any:
        """
        Execute a coroutine with rate limiting.
        
        Args:
            coro: Coroutine to execute
            
        Returns:
            Result of the coroutine
        """
        async with self.semaphore:
            # Apply rate limiting
            if self.min_request_delay > 0:
                async with self.request_lock:
                    elapsed = time.time() - self.last_request_time
                    if elapsed < self.min_request_delay:
                        await asyncio.sleep(self.min_request_delay - elapsed)
                    self.last_request_time = time.time()
            
            # Execute the coroutine
            return await coro
    
    async def execute_all(
        self,
        coroutines: List[Coroutine],
        return_exceptions: bool = True
    ) -> List[Any]:
        """
        Execute all coroutines with rate limiting.
        
        Args:
            coroutines: List of coroutines to execute
            return_exceptions: If True, exceptions are returned instead of raised
            
        Returns:
            List of results (in same order as coroutines)
        """
        if not coroutines:
            return []
        
        logger.info(
            f"Executing {len(coroutines)} tasks "
            f"(max_concurrent={self.max_concurrent}, "
            f"rpm={self.requests_per_minute or 'unlimited'})"
        )
        
        start_time = time.time()
        
        # Wrap each coroutine with rate limiting
        tasks = [self._rate_limited_call(coro) for coro in coroutines]
        
        # Execute all tasks
        results = await asyncio.gather(*tasks, return_exceptions=return_exceptions)
        
        elapsed = time.time() - start_time
        success_count = sum(1 for r in results if not isinstance(r, Exception))
        
        logger.info(
            f"Completed {len(coroutines)} tasks in {elapsed:.1f}s "
            f"({success_count} succeeded, {len(coroutines) - success_count} failed) "
            f"avg={elapsed/len(coroutines):.2f}s/task"
        )
        
        return results


async def parallel_llm_calls(
    items: List[Any],
    call_fn: Callable[[Any], Coroutine],
    max_concurrent: int = 10,
    requests_per_minute: Optional[int] = None,
    progress_callback: Optional[Callable[[int, int], None]] = None
) -> List[Any]:
    """
    Execute LLM calls in parallel with rate limiting.
    
    Args:
        items: List of items to process
        call_fn: Async function that takes an item and returns a coroutine
        max_concurrent: Maximum concurrent requests
        requests_per_minute: API rate limit
        progress_callback: Optional callback(completed, total) for progress tracking
        
    Returns:
        List of results (in same order as items)
        
    Example:
        ```python
        async def process_segment(segment_id):
            return await llm_api.generate(segment_id)
        
        results = await parallel_llm_calls(
            segment_ids,
            process_segment,
            max_concurrent=10,
            requests_per_minute=1000
        )
        ```
    """
    if not items:
        return []
    
    executor = RateLimitedExecutor(
        max_concurrent=max_concurrent,
        requests_per_minute=requests_per_minute
    )
    
    # Create coroutines for all items
    coroutines = [call_fn(item) for item in items]
    
    # Execute with rate limiting
    results = await executor.execute_all(coroutines, return_exceptions=True)
    
    # Call progress callback if provided
    if progress_callback:
        progress_callback(len(items), len(items))
    
    return results


async def parallel_map(
    items: List[Any],
    async_fn: Callable[[Any], Coroutine],
    max_concurrent: int = 10,
    **kwargs
) -> List[Any]:
    """
    Map an async function over items in parallel.
    
    Simpler interface for parallel execution without rate limiting.
    
    Args:
        items: List of items to process
        async_fn: Async function to apply to each item
        max_concurrent: Maximum concurrent operations
        **kwargs: Additional args passed to RateLimitedExecutor
        
    Returns:
        List of results
    """
    executor = RateLimitedExecutor(max_concurrent=max_concurrent, **kwargs)
    coroutines = [async_fn(item) for item in items]
    return await executor.execute_all(coroutines, return_exceptions=True)


class BatchProcessor:
    """
    Process items in batches with parallel execution within each batch.
    
    Useful when you want to process items in chunks (e.g., to periodically
    save progress or free memory).
    """
    
    def __init__(
        self,
        batch_size: int = 50,
        max_concurrent: int = 10,
        progress_callback: Optional[Callable[[int, int], None]] = None
    ):
        """
        Initialize batch processor.
        
        Args:
            batch_size: Number of items per batch
            max_concurrent: Max concurrent operations per batch
            progress_callback: Optional callback(completed, total)
        """
        self.batch_size = batch_size
        self.max_concurrent = max_concurrent
        self.progress_callback = progress_callback
    
    async def process_batches(
        self,
        items: List[Any],
        process_fn: Callable[[Any], Coroutine]
    ) -> List[Any]:
        """
        Process items in batches.
        
        Args:
            items: List of items to process
            process_fn: Async function to process each item
            
        Returns:
            List of all results
        """
        if not items:
            return []
        
        total = len(items)
        all_results = []
        
        # Process in batches
        for i in range(0, total, self.batch_size):
            batch = items[i:i + self.batch_size]
            batch_num = (i // self.batch_size) + 1
            total_batches = (total + self.batch_size - 1) // self.batch_size
            
            logger.info(
                f"Processing batch {batch_num}/{total_batches} "
                f"({len(batch)} items)"
            )
            
            # Process batch in parallel
            results = await parallel_map(
                batch,
                process_fn,
                max_concurrent=self.max_concurrent
            )
            
            all_results.extend(results)
            
            # Progress callback
            if self.progress_callback:
                completed = min(i + self.batch_size, total)
                self.progress_callback(completed, total)
            
            # Small delay between batches
            if i + self.batch_size < total:
                await asyncio.sleep(0.1)
        
        return all_results
