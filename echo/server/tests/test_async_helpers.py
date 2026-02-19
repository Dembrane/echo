"""
Tests for run_async_in_new_loop — specifically the concurrent-greenlet scenario
that caused "Future attached to a different loop" errors under load.

Regression test for: multiple concurrent callers sharing the same OS thread
(as dramatiq-gevent greenlets do) must not share an event loop.
"""

import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

import pytest

from dembrane.async_helpers import run_async_in_new_loop


async def _simple_coro(value: int) -> int:
    """Minimal async coroutine that does a thread-pool round-trip (like run_in_thread_pool)."""
    loop = asyncio.get_running_loop()
    # Simulate run_in_thread_pool: submit blocking work to the executor
    result = await loop.run_in_executor(None, lambda: value * 2)
    return result


async def _gather_coro(value: int) -> int:
    """Uses asyncio.gather internally — matches what summarize_conversation does."""
    loop = asyncio.get_running_loop()
    a, b = await asyncio.gather(
        loop.run_in_executor(None, lambda: value + 1),
        loop.run_in_executor(None, lambda: value + 2),
    )
    return a + b


def test_run_async_in_new_loop_basic():
    """Single call works correctly."""
    result = run_async_in_new_loop(_simple_coro(5))
    assert result == 10


def test_run_async_in_new_loop_with_gather():
    """Gather inside coroutine works correctly."""
    result = run_async_in_new_loop(_gather_coro(3))
    assert result == 9  # (3+1) + (3+2) = 9


def test_run_async_in_new_loop_concurrent_threads():
    """
    Simulates the dramatiq-gevent scenario: N threads all calling
    run_async_in_new_loop concurrently. Before the fix, they shared
    a cached loop by thread ID, causing "Future attached to a different
    loop" errors under concurrent load.
    """
    errors = []
    results = []

    def worker(value: int):
        try:
            r = run_async_in_new_loop(_gather_coro(value))
            results.append(r)
        except Exception as e:
            errors.append(str(e))

    # Simulate 10 concurrent callers (matches or exceeds Stage 3 load test concurrency)
    with ThreadPoolExecutor(max_workers=10) as pool:
        futures = [pool.submit(worker, i) for i in range(10)]
        for f in as_completed(futures):
            f.result()  # re-raises if the thread itself crashed

    assert errors == [], f"Concurrent run_async_in_new_loop raised errors: {errors}"
    assert len(results) == 10


def test_run_async_in_new_loop_same_thread_sequential():
    """
    Calls from the same thread are safe when sequential.
    Verifies loop is properly closed between calls (no 'loop is closed' error).
    """
    for i in range(5):
        result = run_async_in_new_loop(_simple_coro(i))
        assert result == i * 2


def test_run_async_in_new_loop_same_thread_id_concurrent():
    """
    Reproduces the exact bug: multiple coroutines submitted from threads
    that all share the same thread ID (simulated by patching get_ident).

    Before the fix (persistent loop per thread ID), all concurrent callers
    shared one loop → "Future attached to a different loop".
    After the fix (fresh loop per call), each call is isolated.
    """
    original_get_ident = threading.get_ident
    # Make all threads report the same thread ID — exactly what gevent does
    threading.get_ident = lambda: 99999

    errors = []
    results = []

    def worker(value: int):
        try:
            r = run_async_in_new_loop(_gather_coro(value))
            results.append(r)
        except Exception as e:
            errors.append(str(e))

    try:
        with ThreadPoolExecutor(max_workers=5) as pool:
            futures = [pool.submit(worker, i) for i in range(5)]
            for f in as_completed(futures):
                f.result()
    finally:
        threading.get_ident = original_get_ident

    assert errors == [], f"Same-thread-ID concurrent calls raised errors: {errors}"
    assert len(results) == 5


def test_run_async_in_new_loop_rejects_non_coroutine():
    """Type guard still works."""
    with pytest.raises(TypeError, match="expects a coroutine or Future"):
        run_async_in_new_loop(42)  # type: ignore
