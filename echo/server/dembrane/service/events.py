from __future__ import annotations

from dataclasses import dataclass
from logging import getLogger
from typing import Any

logger = getLogger("dembrane.service.events")


@dataclass(slots=True)
class ChunkCreatedEvent:
    """Domain event emitted whenever a new conversation chunk is created."""

    chunk_id: str
    conversation_id: str


class EventService:
    """Minimal event dispatcher used by services during tests and local runs."""

    def publish(self, event: Any) -> None:
        """
        Publish an event downstream.

        The default implementation simply logs the event so tests can assert the call.
        Production deployments are expected to provide a richer implementation.
        """
        logger.info("Event published: %s", event)
