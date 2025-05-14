import time
from enum import Enum
from typing import Optional
from logging import getLogger

from dembrane.directus import directus

logger = getLogger("status")


class ProcessingStatus(Enum):
    PENDING = "PENDING"
    PROCESSING = "PROCESSING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"


def add_processing_status(
    collection_name: str,
    item_id: str,
    event: str,
    message: str,
    json: Optional[dict] = None,
    duration_ms: Optional[int] = None,
) -> int:
    logger.info(f"{event} {message} {str(json)} - {duration_ms}")
    return directus.create_item(
        "processing_status",
        {
            "collection_name": collection_name,
            "item_id": item_id,
            "event": event,
            "message": message,
            "json": json,
            "duration_ms": duration_ms,
        },
    )["data"]["id"]


class ProcessingStatusContext:
    """Context manager to automatically log processing status events with duration."""

    def __init__(
        self,
        collection_name: str,
        item_id: str,
        event_prefix: str,
        message: str = "",
        json: Optional[dict] = None,
    ):
        self.collection_name = collection_name
        self.item_id = item_id
        self.event_prefix = event_prefix
        self.message = message
        self.json = json
        self.start_time = None
        self.logger = getLogger(f"status.{self.event_prefix}")

        self.processing_status_start_id = None
        self.processing_status_failed_id = None
        self.processing_status_completed_id = None

    def __enter__(self):
        # Log start event without duration
        self.start_time = time.time()
        self.processing_status_start_id = add_processing_status(
            self.collection_name,
            self.item_id,
            event=f"{self.event_prefix}.started",
            message=self.message,
            json=self.json,
        )
        self.logger.info(f"{self.processing_status_start_id} {self.message}")
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        # Compute duration in milliseconds
        duration_ms = int((time.time() - self.start_time) * 1000)
        if exc_type:
            # Log failure event with error message and duration
            err_msg = str(exc_value)
            self.processing_status_failed_id = add_processing_status(
                self.collection_name,
                self.item_id,
                event=f"{self.event_prefix}.failed",
                message=err_msg,
                json=self.json,
                duration_ms=duration_ms,
            )
            self.logger.error(
                f"{self.processing_status_failed_id} {err_msg} (duration: {duration_ms/1000}s) (started: {self.processing_status_start_id})"
            )
        else:
            # Log completion event with message and duration
            self.processing_status_completed_id = add_processing_status(
                self.collection_name,
                self.item_id,
                event=f"{self.event_prefix}.completed",
                message=self.message,
                json=self.json,
                duration_ms=duration_ms,
            )
            self.logger.info(
                f"{self.processing_status_completed_id} {self.message} (duration: {duration_ms/1000}s) (started: {self.processing_status_start_id})"
            )
        # Do not suppress exceptions
        return False
