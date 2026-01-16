"""
Stream status utilities for real-time user notifications.

This module provides utilities to emit status events during LLM streaming,
allowing the frontend to show empathetic notifications when requests take longer
than expected (e.g., due to high load or failover scenarios).
"""

from __future__ import annotations

import asyncio
import json
from typing import AsyncGenerator, Optional
from enum import Enum


class StreamStatusType(str, Enum):
    """Status event types for stream notifications."""
    PROCESSING = "processing"  # Initial processing started
    RETRYING = "retrying"      # Request is being retried
    HIGH_LOAD = "high_load"    # System experiencing high demand
    READY = "ready"            # Response starting


def format_status_event(
    status_type: StreamStatusType,
    message: str,
    attempt: Optional[int] = None,
) -> str:
    """
    Format a status event for the Vercel AI SDK data stream protocol.
    
    Uses code "2:" for data events which are exposed via `data` prop in useChat.
    
    Args:
        status_type: Type of status event
        message: Human-readable message for the notification
        attempt: Optional retry attempt number
    
    Returns:
        Formatted SSE data event string
    """
    payload = {
        "type": status_type.value,
        "message": message,
    }
    if attempt is not None:
        payload["attempt"] = attempt
    
    # Code "2:" is for data events in Vercel AI SDK protocol
    # The value must be an array
    return f"2:{json.dumps([payload])}\n"


async def stream_with_status(
    stream_generator: AsyncGenerator[str, None],
    delay_threshold_seconds: float = 3.0,
    protocol: str = "data",
) -> AsyncGenerator[str, None]:
    """
    Wrap a stream generator to emit status events if response is delayed.
    
    If no content is received within `delay_threshold_seconds`, emits a
    "high_load" status event to notify the user.
    
    Args:
        stream_generator: The underlying stream generator
        delay_threshold_seconds: Seconds to wait before emitting status
        protocol: "data" or "text" - only "data" supports status events
    
    Yields:
        Stream chunks with optional status events prepended
    """
    if protocol != "data":
        # Text protocol doesn't support status events
        async for chunk in stream_generator:
            yield chunk
        return
    
    status_emitted = False
    first_chunk_received = False
    
    # Create an async iterator from the generator
    stream_iter = stream_generator.__aiter__()
    
    # Queue to hold chunks from the stream
    chunk_queue: asyncio.Queue[tuple[str | None, Exception | None]] = asyncio.Queue()
    
    async def stream_reader():
        """Read from the stream and put chunks in queue."""
        try:
            async for chunk in stream_iter:
                await chunk_queue.put((chunk, None))
            await chunk_queue.put((None, None))  # Signal end of stream
        except Exception as e:
            await chunk_queue.put((None, e))
    
    # Start reading stream in background
    reader_task = asyncio.create_task(stream_reader())
    
    try:
        while True:
            try:
                # Wait for next chunk with timeout
                if not first_chunk_received:
                    timeout = delay_threshold_seconds
                else:
                    timeout = None  # No timeout after first chunk
                
                chunk, error = await asyncio.wait_for(
                    chunk_queue.get(),
                    timeout=timeout,
                )
                
                if error is not None:
                    raise error
                
                if chunk is None:
                    # End of stream
                    break
                
                first_chunk_received = True
                yield chunk
                
            except asyncio.TimeoutError:
                # No chunk received within threshold - emit status
                if not status_emitted and not first_chunk_received:
                    status_emitted = True
                    yield format_status_event(
                        StreamStatusType.HIGH_LOAD,
                        "We're experiencing high demand. Still working on your request...",
                    )
                
                # Now wait indefinitely for the first chunk
                chunk, error = await chunk_queue.get()
                
                if error is not None:
                    raise error
                
                if chunk is None:
                    break
                
                first_chunk_received = True
                yield chunk
    
    finally:
        reader_task.cancel()
        try:
            await reader_task
        except asyncio.CancelledError:
            pass


__all__ = [
    "StreamStatusType",
    "format_status_event",
    "stream_with_status",
]
