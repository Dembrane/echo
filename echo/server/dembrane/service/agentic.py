from __future__ import annotations

from typing import Any, Literal, Optional
from logging import getLogger
from contextlib import AbstractContextManager

from dembrane.utils import generate_uuid, get_utc_timestamp
from dembrane.directus import (
    DirectusClient,
    DirectusBadRequest,
    directus,
    directus_client_context,
)

logger = getLogger("dembrane.service.agentic")

RUN_COLLECTION = "project_agentic_run"
RUN_EVENT_COLLECTION = "project_agentic_run_event"
TERMINAL_RUN_STATUSES = {"completed", "failed", "timeout"}
RunStatus = Literal["queued", "running", "completed", "failed", "timeout"]


class AgenticRunServiceException(Exception):
    pass


class AgenticRunNotFoundException(AgenticRunServiceException):
    pass


class AgenticRunService:
    def __init__(self, directus_client: Optional[DirectusClient] = None) -> None:
        self._directus_client = directus_client or directus

    def _client_context(
        self, override_client: Optional[DirectusClient] = None
    ) -> AbstractContextManager[DirectusClient]:
        return directus_client_context(override_client or self._directus_client)

    def create_run(
        self,
        *,
        project_id: str,
        directus_user_id: str,
        project_chat_id: Optional[str] = None,
        status: RunStatus = "queued",
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "id": generate_uuid(),
            "project_id": project_id,
            "directus_user_id": directus_user_id,
            "status": status,
            "last_event_seq": 0,
            "latest_output": None,
            "latest_error": None,
            "latest_error_code": None,
            "started_at": None,
            "completed_at": None,
        }
        if project_chat_id is not None:
            payload["project_chat_id"] = project_chat_id

        try:
            with self._client_context() as client:
                created = client.create_item(RUN_COLLECTION, payload)["data"]
        except DirectusBadRequest as exc:
            logger.error("Failed to create agentic run: %s", exc)
            raise AgenticRunServiceException("Failed to create run") from exc

        return created

    def get_by_id_or_raise(self, run_id: str) -> dict[str, Any]:
        try:
            with self._client_context() as client:
                rows = client.get_items(
                    RUN_COLLECTION,
                    {
                        "query": {
                            "filter": {"id": {"_eq": run_id}},
                            "limit": 1,
                        }
                    },
                )
        except DirectusBadRequest as exc:
            logger.error("Failed to read run %s: %s", run_id, exc)
            raise AgenticRunServiceException("Failed to load run") from exc

        if not rows:
            raise AgenticRunNotFoundException(f"Run not found: {run_id}")
        return rows[0]

    def set_status(
        self,
        run_id: str,
        status: RunStatus,
        *,
        latest_output: Optional[str] = None,
        latest_error: Optional[str] = None,
        latest_error_code: Optional[str] = None,
    ) -> dict[str, Any]:
        run = self.get_by_id_or_raise(run_id)
        now = get_utc_timestamp().isoformat()
        update_data: dict[str, Any] = {"status": status}

        if status == "running" and not run.get("started_at"):
            update_data["started_at"] = now

        if status == "queued":
            update_data["completed_at"] = None

        if status in TERMINAL_RUN_STATUSES:
            update_data["completed_at"] = now

        if latest_output is not None:
            update_data["latest_output"] = latest_output
        if latest_error is not None:
            update_data["latest_error"] = latest_error
        if latest_error_code is not None:
            update_data["latest_error_code"] = latest_error_code

        try:
            with self._client_context() as client:
                updated = client.update_item(RUN_COLLECTION, run_id, update_data)["data"]
        except DirectusBadRequest as exc:
            logger.error("Failed to update run %s status to %s: %s", run_id, status, exc)
            raise AgenticRunServiceException("Failed to update run status") from exc

        return updated

    def append_event(self, run_id: str, event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        seq = self._next_seq(run_id)
        event_payload = {
            "project_agentic_run_id": run_id,
            "seq": seq,
            "event_type": event_type,
            "payload": payload,
            "timestamp": get_utc_timestamp().isoformat(),
        }

        try:
            with self._client_context() as client:
                event = client.create_item(RUN_EVENT_COLLECTION, event_payload)["data"]
                client.update_item(RUN_COLLECTION, run_id, {"last_event_seq": seq})
        except DirectusBadRequest as exc:
            logger.error("Failed to append event for run %s: %s", run_id, exc)
            raise AgenticRunServiceException("Failed to append event") from exc

        return event

    def list_events(
        self,
        run_id: str,
        *,
        after_seq: int = 0,
        limit: int = 500,
    ) -> list[dict[str, Any]]:
        filter_data: dict[str, Any] = {"project_agentic_run_id": {"_eq": run_id}}
        if after_seq > 0:
            filter_data["seq"] = {"_gt": after_seq}

        try:
            with self._client_context() as client:
                events = client.get_items(
                    RUN_EVENT_COLLECTION,
                    {
                        "query": {
                            "filter": filter_data,
                            "sort": "seq",
                            "limit": limit,
                        }
                    },
                )
        except DirectusBadRequest as exc:
            logger.error("Failed to list events for run %s: %s", run_id, exc)
            raise AgenticRunServiceException("Failed to list run events") from exc

        return events or []

    def get_latest_event(
        self,
        run_id: str,
        *,
        event_type: Optional[str] = None,
    ) -> Optional[dict[str, Any]]:
        filter_data: dict[str, Any] = {"project_agentic_run_id": {"_eq": run_id}}
        if event_type is not None:
            filter_data["event_type"] = {"_eq": event_type}

        try:
            with self._client_context() as client:
                rows = client.get_items(
                    RUN_EVENT_COLLECTION,
                    {
                        "query": {
                            "filter": filter_data,
                            "sort": "-seq",
                            "limit": 1,
                        }
                    },
                )
        except DirectusBadRequest as exc:
            logger.error("Failed to read latest event for run %s: %s", run_id, exc)
            raise AgenticRunServiceException("Failed to read latest run event") from exc

        if not rows:
            return None
        return rows[0]

    def _next_seq(self, run_id: str) -> int:
        try:
            with self._client_context() as client:
                rows = client.get_items(
                    RUN_EVENT_COLLECTION,
                    {
                        "query": {
                            "filter": {"project_agentic_run_id": {"_eq": run_id}},
                            "fields": ["seq"],
                            "sort": "-seq",
                            "limit": 1,
                        }
                    },
                )
        except DirectusBadRequest as exc:
            logger.error("Failed to get next seq for run %s: %s", run_id, exc)
            raise AgenticRunServiceException("Failed to read event sequence") from exc

        current = 0
        if rows:
            current = int(rows[0].get("seq") or 0)
        return current + 1
