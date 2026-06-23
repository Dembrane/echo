"""
Tests for run_async_in_new_loop.

It runs coroutines from sync contexts (Dramatiq actors) on a single long-lived
background event loop in a dedicated real OS thread. Regression coverage for the
production failures this design fixes:
  * concurrent callers sharing one OS thread (dramatiq-gevent greenlets) must not
    corrupt each other's loop ("Future attached to a different loop"),
  * a long-lived httpx.AsyncClient reused across calls must keep working
    (no "Event loop is closed"), and
  * async code that relies on sniffio must run under gevent without
    AsyncLibraryNotFoundError (covered by test_gevent_async_httpx).
"""

import sys
import asyncio
import textwrap
import threading
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed

import pytest

from dembrane.async_helpers import run_async_in_new_loop, _ensure_background_loop


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
    Sequential calls from the same thread all succeed. The background loop is
    reused (never closed) between calls, so there is no 'loop is closed' error.
    """
    for i in range(5):
        result = run_async_in_new_loop(_simple_coro(i))
        assert result == i * 2


def test_run_async_in_new_loop_same_thread_id_concurrent():
    """
    Reproduces the exact bug: multiple coroutines submitted from threads
    that all share the same thread ID (simulated by patching get_ident).

    Before the fix (persistent loop per thread ID), all concurrent callers
    shared one loop driven by multiple greenlets → "Future attached to a
    different loop". The shared background loop runs on its own dedicated thread,
    so caller thread IDs are irrelevant.
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


def test_background_loop_is_reused():
    """The same long-lived loop backs every call (never recreated/closed)."""
    run_async_in_new_loop(_simple_coro(1))
    loop_a = _ensure_background_loop()
    run_async_in_new_loop(_simple_coro(2))
    loop_b = _ensure_background_loop()
    assert loop_a is loop_b
    assert not loop_a.is_closed()


def test_reused_async_client_across_calls():
    """
    Regression for task_merge_conversation_chunks' "Event loop is closed".

    A long-lived httpx.AsyncClient (like async_directus) bound to the background
    loop on first use must keep working across many run_async_in_new_loop calls.
    The old fresh-loop-per-call design orphaned the client's pool on the closed
    loop, so the second call raised RuntimeError("Event loop is closed").
    """
    import httpx

    client = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, json={"ok": True})),
        base_url="http://test",
    )

    async def _call() -> bool:
        resp = await client.get("/ping")
        return resp.json()["ok"]

    try:
        for _ in range(10):
            assert run_async_in_new_loop(_call()) is True
    finally:
        run_async_in_new_loop(client.aclose())


def test_gevent_async_httpx():
    """
    Regression for task_summarize_conversation's sniffio
    AsyncLibraryNotFoundError under dramatiq-gevent.

    Runs in a subprocess so gevent's monkeypatch is applied before imports (as
    dramatiq-gevent does). Many greenlets drive async httpx (which calls
    sniffio.current_async_library()) through run_async_in_new_loop concurrently.
    """
    script = textwrap.dedent(
        """
        from gevent import monkey; monkey.patch_all()
        import asyncio, httpx, gevent
        from dembrane.async_helpers import run_async_in_new_loop

        _client = httpx.AsyncClient(
            transport=httpx.MockTransport(lambda _request: httpx.Response(200, json={"ok": True})),
            base_url="http://test",
        )

        async def work(_):
            await asyncio.sleep(0.02)
            r = await _client.get("/ping")  # sniffio detection happens here
            return r.json()["ok"]

        jobs = [gevent.spawn(lambda i=i: run_async_in_new_loop(work(i))) for i in range(20)]
        gevent.joinall(jobs, timeout=30)
        errs = [repr(j.exception) for j in jobs if j.exception is not None]
        assert not errs, errs
        assert all(j.value is True for j in jobs)
        print("PASS")
        """
    )
    proc = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, timeout=120
    )
    assert proc.returncode == 0, f"stdout={proc.stdout}\nstderr={proc.stderr}"
    assert "PASS" in proc.stdout
