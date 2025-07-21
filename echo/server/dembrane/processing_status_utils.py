import time
from enum import Enum
from typing import Any, Type, Optional
from logging import getLogger
from typing_extensions import Literal

from dembrane.directus import directus_client_context

logger = getLogger("status")


class ProcessingStatus(Enum):
    PENDING = "PENDING"
    PROCESSING = "PROCESSING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"


def add_processing_status(
    conversation_id: Optional[str] = None,
    conversation_chunk_id: Optional[str] = None,
    project_id: Optional[str] = None,
    project_analysis_run_id: Optional[str] = None,
    event: Optional[str] = None,
    message: Optional[str] = None,
    duration_ms: Optional[int] = None,
    parent_id: Optional[int] = None,
) -> int:
    logger.info(f"{event} {message} - {duration_ms}")
    with directus_client_context() as client:
        return client.create_item(
            "processing_status",
            {
                "conversation_id": conversation_id,
                "conversation_chunk_id": conversation_chunk_id,
                "project_id": project_id,
                "project_analysis_run_id": project_analysis_run_id,
                "event": event,
                "message": message,
                "duration_ms": duration_ms,
                "parent_id": parent_id,
            },
        )["data"]["id"]


def set_error_status(
    error: str,
    conversation_chunk_id: Optional[str] = None,
    raise_on_error: bool = False,
) -> None:
    from dembrane.service import conversation_service

    exceptions = []

    try:
        if conversation_chunk_id:
            conversation_service.update_chunk(
                conversation_chunk_id,
                error=error,
            )
    except Exception as e:
        logger.error(
            f"Error setting error status for conversation chunk {conversation_chunk_id}: {e}"
        )
        exceptions.append(e)

    if exceptions:
        error_message = (
            f"Error setting error status for conversation chunk '{conversation_chunk_id}'"
            f": {str(exceptions)}"
        )
        if raise_on_error:
            raise Exception(error_message)
        else:
            logger.error(error_message)

    return


class ProcessingStatusContext:
    """Context manager to automatically log processing status events with duration."""

    def __init__(
        self,
        project_id: Optional[str] = None,
        project_analysis_run_id: Optional[str] = None,
        conversation_id: Optional[str] = None,
        conversation_chunk_id: Optional[str] = None,
        message: Optional[str] = None,
        event_prefix: Optional[str] = None,
    ):
        """
        Context manager to automatically log processing status events with duration.

        When entering the context, the context manager will log a STARTED event with the message and duration.
        When an exception occurs, the context manager will log a FAILED event with the error message and duration.
        When no exception occurs, the context manager will log a COMPLETED event with the message and duration.

        Args:
            project_id: The ID of the project. (str)
            project_analysis_run_id: The ID of the project analysis run. (str)
            conversation_id: The ID of the conversation. (str)
            conversation_chunk_id: The ID of the conversation chunk. (str)
            message: The message to log. (str)
            event_prefix: The prefix of the event. (str) Conventionally, you will see this being set to method name.
        """
        self.project_id = project_id
        self.project_analysis_run_id = project_analysis_run_id
        self.conversation_id = conversation_id
        self.conversation_chunk_id = conversation_chunk_id
        self.event_prefix = event_prefix
        self.message = message
        self.exit_message: Optional[str] = None  # Custom exit message
        self.start_time: float = 0.0
        self.logger = getLogger(f"status.{self.event_prefix}")

        self.processing_status_start_id: Optional[int] = None
        self.processing_status_failed_id: Optional[int] = None
        self.processing_status_completed_id: Optional[int] = None

    def set_exit_message(self, message: str) -> None:
        """Set a custom message to be used in the exit event."""
        self.exit_message = message

    def __enter__(self) -> "ProcessingStatusContext":
        # Log start event without duration
        self.start_time = time.time()
        self.processing_status_start_id = add_processing_status(
            project_id=self.project_id,
            project_analysis_run_id=self.project_analysis_run_id,
            conversation_id=self.conversation_id,
            conversation_chunk_id=self.conversation_chunk_id,
            event=f"{self.event_prefix}.started",
            message=self.message if self.message else "",
        )
        self.logger.info(f"{self.processing_status_start_id} {self.message}")
        return self

    def __exit__(
        self,
        exc_type: Optional[Type[BaseException]],
        exc_value: Optional[BaseException],
        traceback: Any,
    ) -> Literal[False]:
        duration_ms = int((time.time() - self.start_time) * 1000)
        # if exception occurs, log FAILED event with error message and duration

        if exc_type:
            if self.exit_message:
                message = self.exit_message + f" -\n {str(exc_value)}"
            else:
                message = str(exc_value)

            self.processing_status_failed_id = add_processing_status(
                project_id=self.project_id,
                project_analysis_run_id=self.project_analysis_run_id,
                conversation_id=self.conversation_id,
                conversation_chunk_id=self.conversation_chunk_id,
                event=f"{self.event_prefix}.failed",
                message=message,
                duration_ms=duration_ms,
                parent_id=self.processing_status_start_id,
            )
            self.logger.error(
                f"{self.processing_status_failed_id} {message} (duration: {duration_ms / 1000}s) (started: {self.processing_status_start_id})"
            )
        # if no exception occurs, log COMPLETED event with message and duration
        else:
            if self.exit_message:
                message = self.exit_message
            else:
                message = self.message if self.message else ""

            self.processing_status_completed_id = add_processing_status(
                project_id=self.project_id,
                project_analysis_run_id=self.project_analysis_run_id,
                conversation_id=self.conversation_id,
                conversation_chunk_id=self.conversation_chunk_id,
                event=f"{self.event_prefix}.completed",
                message=message,
                duration_ms=duration_ms,
                parent_id=self.processing_status_start_id,
            )
            self.logger.info(
                f"{self.processing_status_completed_id} {message} (duration: {duration_ms / 1000}s) (started: {self.processing_status_start_id})"
            )

        return False
