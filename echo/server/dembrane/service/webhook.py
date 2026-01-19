# webhook.py
"""
Webhook service for dispatching HTTP callbacks on conversation events.

Events:
- conversation.created: Fired when a new conversation is created
- conversation.transcribed: Fired when all chunks are transcribed
- conversation.summarized: Fired when summary is generated
"""

import json
import hmac
import hashlib
from typing import Any, Dict, List, Optional
from logging import getLogger
from datetime import datetime, timezone

import requests

from dembrane.directus import DirectusClient, DirectusBadRequest, directus, directus_client_context
from dembrane.settings import get_settings

logger = getLogger("dembrane.service.webhook")

# Valid webhook event types
WEBHOOK_EVENTS = [
    "conversation.created",
    "conversation.transcribed",
    "conversation.summarized",
]

# HTTP timeouts for webhook dispatch
WEBHOOK_CONNECT_TIMEOUT = 10  # seconds
WEBHOOK_READ_TIMEOUT = 30  # seconds


class WebhookServiceException(Exception):
    pass


class WebhookService:
    """Service for managing and dispatching project webhooks."""

    def __init__(self, directus_client: Optional[DirectusClient] = None) -> None:
        self.directus_client = directus_client or directus
        self.settings = get_settings()

    def is_webhooks_enabled(self) -> bool:
        """Check if webhooks are globally enabled via feature flag."""
        return self.settings.feature_flags.webhooks_enabled

    def get_webhooks_for_project(
        self,
        project_id: str,
        event: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """
        Get all enabled webhooks for a project, optionally filtered by event type.

        Args:
            project_id: The project ID
            event: Optional event type to filter by (e.g., "conversation.created")

        Returns:
            List of webhook configurations
        """
        try:
            with directus_client_context(self.directus_client) as client:
                webhooks = client.get_items(
                    "project_webhook",
                    {
                        "query": {
                            "filter": {
                                "project_id": {"_eq": project_id},
                                "status": {"_eq": "published"},
                            },
                            "fields": ["id", "name", "url", "secret", "events", "project_id"],
                        }
                    },
                )
        except DirectusBadRequest as e:
            logger.error(f"Failed to fetch webhooks for project {project_id}: {e}")
            return []

        if not webhooks:
            return []

        # Filter by event if specified
        if event:
            filtered = []
            for webhook in webhooks:
                events = webhook.get("events")
                # Parse events JSON if it's a string
                if isinstance(events, str):
                    try:
                        events = json.loads(events)
                    except json.JSONDecodeError:
                        events = []
                if events and event in events:
                    filtered.append(webhook)
            return filtered

        return webhooks

    def build_payload(
        self,
        event: str,
        conversation: Dict[str, Any],
        project: Dict[str, Any],
        transcript: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Build the webhook payload for an event.

        Args:
            event: The event type
            conversation: The conversation data
            project: The project data
            transcript: Optional pre-built transcript string

        Returns:
            The webhook payload dictionary
        """
        # Extract tags as string array
        tags: List[str] = []
        conversation_tags = conversation.get("tags", [])
        for tag in conversation_tags:
            if isinstance(tag, dict):
                project_tag = tag.get("project_tag_id")
                if isinstance(project_tag, dict):
                    tag_text = project_tag.get("text")
                    if tag_text:
                        tags.append(tag_text)
                elif isinstance(project_tag, str):
                    # Just the ID, not expanded
                    tags.append(project_tag)

        # Build conversation data
        conversation_data: Dict[str, Any] = {
            "id": conversation.get("id"),
            "created_at": conversation.get("created_at"),
            "updated_at": conversation.get("updated_at"),
            "participant_name": conversation.get("participant_name"),
            "participant_email": conversation.get("participant_email"),
            "duration": conversation.get("duration"),
            "source": conversation.get("source"),
            "is_finished": conversation.get("is_finished"),
            "is_all_chunks_transcribed": conversation.get("is_all_chunks_transcribed"),
            "tags": tags,
        }

        # Include transcript for transcribed and summarized events
        if event in ("conversation.transcribed", "conversation.summarized"):
            conversation_data["transcript"] = transcript or ""

        # Include summary for summarized events
        if event == "conversation.summarized":
            conversation_data["summary"] = conversation.get("summary") or ""

        # Build project data
        project_data: Dict[str, Any] = {
            "id": project.get("id"),
            "name": project.get("name"),
            "language": project.get("language"),
        }

        return {
            "event": event,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "conversation": conversation_data,
            "project": project_data,
        }

    def build_transcript(self, conversation_id: str) -> str:
        """
        Build the full transcript from conversation chunks.

        Args:
            conversation_id: The conversation ID

        Returns:
            The combined transcript string
        """
        try:
            with directus_client_context(self.directus_client) as client:
                chunks = client.get_items(
                    "conversation_chunk",
                    {
                        "query": {
                            "filter": {"conversation_id": {"_eq": conversation_id}},
                            "fields": ["id", "transcript", "timestamp"],
                            "sort": "timestamp",
                            "limit": 2000,
                        }
                    },
                )
        except DirectusBadRequest as e:
            logger.error(f"Failed to fetch chunks for transcript: {e}")
            return ""

        if not chunks:
            return ""

        transcripts = []
        for chunk in chunks:
            transcript = chunk.get("transcript")
            if transcript:
                transcripts.append(transcript.strip())

        return "\n".join(transcripts)

    def compute_signature(self, payload: Dict[str, Any], secret: str) -> str:
        """
        Compute HMAC-SHA256 signature for webhook payload.

        Args:
            payload: The payload dictionary
            secret: The webhook secret

        Returns:
            The hex-encoded signature
        """
        payload_bytes = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
        signature = hmac.new(
            secret.encode("utf-8"),
            payload_bytes,
            hashlib.sha256,
        ).hexdigest()
        return f"sha256={signature}"

    def dispatch_webhook_sync(
        self,
        webhook: Dict[str, Any],
        payload: Dict[str, Any],
    ) -> tuple[int, str]:
        """
        Synchronously dispatch a webhook HTTP request.

        Args:
            webhook: The webhook configuration
            payload: The payload to send

        Returns:
            Tuple of (status_code, response_text)

        Raises:
            requests.RequestException: On HTTP errors
        """
        url = webhook.get("url")
        secret = webhook.get("secret")
        webhook_id = webhook.get("id")
        webhook_name = webhook.get("name", "unnamed")

        if not url:
            raise WebhookServiceException(f"Webhook {webhook_id} has no URL")

        headers = {
            "Content-Type": "application/json",
            "User-Agent": "Dembrane-Webhook/1.0",
            "X-Webhook-Event": payload.get("event", "unknown"),
        }

        # Add signature if secret is configured
        if secret:
            signature = self.compute_signature(payload, secret)
            headers["X-Webhook-Signature"] = signature

        logger.info(
            f"Dispatching webhook '{webhook_name}' ({webhook_id}) to {url} for event {payload.get('event')}"
        )

        response = requests.post(
            url,
            json=payload,
            headers=headers,
            timeout=(WEBHOOK_CONNECT_TIMEOUT, WEBHOOK_READ_TIMEOUT),
        )

        logger.info(
            f"Webhook '{webhook_name}' response: status={response.status_code}, "
            f"body={response.text[:200] if response.text else '(empty)'}"
        )

        return response.status_code, response.text

    def enqueue_webhooks_for_event(
        self,
        project_id: str,
        conversation_id: str,
        event: str,
    ) -> int:
        """
        Enqueue webhook dispatch tasks for an event.

        This is the main entry point for triggering webhooks. It:
        1. Checks if webhooks are globally enabled
        2. Fetches matching webhooks for the project/event
        3. Builds the payload
        4. Enqueues Dramatiq tasks for each webhook

        Args:
            project_id: The project ID
            conversation_id: The conversation ID
            event: The event type

        Returns:
            Number of webhooks enqueued
        """
        if not self.is_webhooks_enabled():
            logger.debug("Webhooks are globally disabled, skipping dispatch")
            return 0

        if event not in WEBHOOK_EVENTS:
            logger.warning(f"Invalid webhook event type: {event}")
            return 0

        # Fetch matching webhooks
        webhooks = self.get_webhooks_for_project(project_id, event)
        if not webhooks:
            logger.debug(f"No webhooks configured for project {project_id} event {event}")
            return 0

        # Fetch conversation and project data
        from dembrane.service import conversation_service
        from dembrane.service.project import ProjectService

        try:
            conversation = conversation_service.get_by_id_or_raise(conversation_id, with_tags=True)
        except Exception as e:
            logger.error(f"Failed to fetch conversation {conversation_id} for webhook: {e}")
            return 0

        project_service = ProjectService(directus_client=self.directus_client)
        try:
            project = project_service.get_by_id_or_raise(project_id)
        except Exception as e:
            logger.error(f"Failed to fetch project {project_id} for webhook: {e}")
            return 0

        # Build transcript for relevant events
        transcript = None
        if event in ("conversation.transcribed", "conversation.summarized"):
            transcript = self.build_transcript(conversation_id)

        # Build payload
        payload = self.build_payload(event, conversation, project, transcript)

        # Enqueue dispatch tasks
        from dembrane.tasks import task_dispatch_webhook

        enqueued = 0
        for webhook in webhooks:
            webhook_id = webhook.get("id")
            if not webhook_id:
                continue

            try:
                task_dispatch_webhook.send(webhook_id, payload)
                enqueued += 1
                logger.info(f"Enqueued webhook dispatch for {webhook_id} (event: {event})")
            except Exception as e:
                logger.error(f"Failed to enqueue webhook {webhook_id}: {e}")

        return enqueued


# Module-level singleton for convenience
_webhook_service: Optional[WebhookService] = None


def get_webhook_service() -> WebhookService:
    """Get the singleton WebhookService instance."""
    global _webhook_service
    if _webhook_service is None:
        _webhook_service = WebhookService()
    return _webhook_service


def dispatch_webhooks_for_event(
    project_id: str,
    conversation_id: str,
    event: str,
) -> int:
    """
    Convenience function to dispatch webhooks for an event.

    This is the main entry point to be called from conversation service
    and task handlers.

    Args:
        project_id: The project ID
        conversation_id: The conversation ID
        event: The event type (conversation.created, conversation.transcribed, conversation.summarized)

    Returns:
        Number of webhooks enqueued
    """
    service = get_webhook_service()
    return service.enqueue_webhooks_for_event(project_id, conversation_id, event)
