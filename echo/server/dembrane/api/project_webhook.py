"""
Project Webhook API endpoints.

Provides CRUD operations for project webhooks and webhook testing.
"""

import json
from http import HTTPStatus
from typing import Any, List, Optional
from logging import getLogger
from datetime import datetime, timezone

from fastapi import Depends, APIRouter, HTTPException
from pydantic import BaseModel

from dembrane.utils import generate_uuid
from dembrane.async_helpers import run_in_thread_pool
from dembrane.api.dependency_auth import DependencyDirectusSession, require_directus_client

logger = getLogger("api.project_webhook")

ProjectWebhookRouter = APIRouter(
    tags=["project-webhook"],
    dependencies=[Depends(require_directus_client)],
)


# =============================================================================
# Schemas
# =============================================================================


class WebhookCreateRequestSchema(BaseModel):
    name: str
    url: str
    secret: Optional[str] = None
    events: List[str]


class WebhookUpdateRequestSchema(BaseModel):
    name: Optional[str] = None
    url: Optional[str] = None
    secret: Optional[str] = None
    events: Optional[List[str]] = None
    status: Optional[str] = None


class WebhookResponseSchema(BaseModel):
    id: str
    name: Optional[str] = None
    url: Optional[str] = None
    events: Optional[List[str]] = None
    status: Optional[str] = None
    date_created: Optional[str] = None
    date_updated: Optional[str] = None


class CopyableWebhookSchema(BaseModel):
    id: str
    name: Optional[str] = None
    url: Optional[str] = None
    events: Optional[List[str]] = None
    project_id: str
    project_name: str


class WebhookTestResponseSchema(BaseModel):
    success: bool
    status_code: Optional[int] = None
    message: str


# =============================================================================
# Helpers
# =============================================================================


async def _check_project_access(project_id: str, auth: DependencyDirectusSession) -> dict:
    """Verify reach + the workspace:webhooks policy and return the project.

    workspace:webhooks is tier-gated (changemaker) and sits in the
    admin/owner presets only; legacy projects without a workspace skip
    the tier gate. Staff bypasses the app-layer model.
    """
    if auth.is_admin:
        from dembrane.directus_async import async_directus

        project = await async_directus.get_item("project", project_id)
        if not project or project.get("deleted_at"):
            raise HTTPException(status_code=404, detail="Project not found")
        return project

    from dembrane.api.v2.bff._access import resolve_project_access

    access = await resolve_project_access(project_id, auth)
    access.require("workspace:webhooks")
    return access.project


def _parse_webhook_events(events: Any) -> List[str]:
    """Parse webhook events from string or list format."""
    if isinstance(events, str):
        try:
            return json.loads(events)
        except json.JSONDecodeError:
            return []
    return events or []


# =============================================================================
# Endpoints
# =============================================================================


@ProjectWebhookRouter.get("/{project_id}/webhooks")
async def list_webhooks(
    project_id: str,
    auth: DependencyDirectusSession,
) -> List[WebhookResponseSchema]:
    """List all webhooks for a project."""
    await _check_project_access(project_id, auth)

    from dembrane.directus import directus

    try:
        webhooks = await run_in_thread_pool(
            directus.get_items,
            "project_webhook",
            {
                "query": {
                    "filter": {
                        "project_id": {"_eq": project_id},
                        "deleted_at": {"_null": True},
                    },
                    "fields": [
                        "id",
                        "name",
                        "url",
                        "events",
                        "status",
                        "date_created",
                        "date_updated",
                    ],
                    "sort": "-date_created",
                }
            },
        )
    except Exception as e:
        logger.error(f"Failed to list webhooks for project {project_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to list webhooks") from e

    if not isinstance(webhooks, list):
        webhooks = []

    return [
        WebhookResponseSchema(
            id=webhook.get("id"),
            name=webhook.get("name"),
            url=webhook.get("url"),
            events=_parse_webhook_events(webhook.get("events")),
            status=webhook.get("status"),
            date_created=webhook.get("date_created"),
            date_updated=webhook.get("date_updated"),
        )
        for webhook in webhooks
    ]


@ProjectWebhookRouter.get("/{project_id}/webhooks/copyable")
async def list_copyable_webhooks(
    project_id: str,
    auth: DependencyDirectusSession,
) -> List[CopyableWebhookSchema]:
    """
    List webhooks from other projects that can be copied to this project.

    Returns webhooks from all projects the user has access to, excluding
    the current project. Useful for quickly setting up similar webhooks
    across multiple projects.
    """
    # Verify access to the target project
    await _check_project_access(project_id, auth)

    from dembrane.directus import directus

    try:
        webhooks = await run_in_thread_pool(
            directus.get_items,
            "project_webhook",
            {
                "query": {
                    "filter": {
                        "project_id": {"_neq": project_id},
                        "status": {"_eq": "published"},
                        "deleted_at": {"_null": True},
                    },
                    "fields": [
                        "id",
                        "name",
                        "url",
                        "events",
                        "project_id.id",
                        "project_id.name",
                    ],
                    "sort": ["project_id.name", "name"],
                }
            },
        )
    except Exception as e:
        logger.error(f"Failed to list copyable webhooks: {e}")
        raise HTTPException(status_code=500, detail="Failed to list webhooks") from e

    if not isinstance(webhooks, list):
        webhooks = []

    # The admin client sees every tenant's webhooks; the user-token ACL
    # used to scope this implicitly. Re-scope to projects where the caller
    # holds workspace:webhooks (cached per project across rows).
    allowed_projects: dict[str, bool] = {}

    async def _project_allowed(pid: str) -> bool:
        if auth.is_admin:
            return True
        if pid not in allowed_projects:
            from dembrane.api.v2.bff._access import resolve_project_access

            try:
                access = await resolve_project_access(pid, auth)
                allowed_projects[pid] = access.allows("workspace:webhooks")
            except HTTPException:
                allowed_projects[pid] = False
        return allowed_projects[pid]

    result = []
    for webhook in webhooks:
        project_info = webhook.get("project_id", {})
        if not isinstance(project_info, dict) or not project_info.get("id"):
            continue
        if not await _project_allowed(project_info["id"]):
            continue
        result.append(
            CopyableWebhookSchema(
                id=webhook.get("id"),
                name=webhook.get("name"),
                url=webhook.get("url"),
                events=_parse_webhook_events(webhook.get("events")),
                project_id=project_info.get("id", ""),
                project_name=project_info.get("name", "Unknown Project"),
            )
        )

    return result


@ProjectWebhookRouter.post("/{project_id}/webhooks", status_code=HTTPStatus.CREATED)
async def create_webhook(
    project_id: str,
    body: WebhookCreateRequestSchema,
    auth: DependencyDirectusSession,
) -> WebhookResponseSchema:
    """Create a new webhook for a project."""
    await _check_project_access(project_id, auth)

    from dembrane.directus import directus
    from dembrane.service.webhook import WEBHOOK_EVENTS

    # Validate events
    for event in body.events:
        if event not in WEBHOOK_EVENTS:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid event type: {event}. Valid types: {WEBHOOK_EVENTS}",
            )

    # Validate URL
    if not body.url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="URL must start with http:// or https://")

    try:
        webhook_data = {
            "id": generate_uuid(),
            "project_id": {
                "id": project_id,
            },
            "name": body.name,
            "url": body.url,
            "events": json.dumps(body.events),
            "status": "published",
        }
        if body.secret:
            webhook_data["secret"] = body.secret

        result = await run_in_thread_pool(directus.create_item, "project_webhook", webhook_data)
        webhook = result.get("data", {})
    except Exception as e:
        logger.error(f"Failed to create webhook for project {project_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to create webhook") from e

    return WebhookResponseSchema(
        id=webhook.get("id"),
        name=webhook.get("name"),
        url=webhook.get("url"),
        events=body.events,
        status=webhook.get("status"),
        date_created=webhook.get("date_created"),
        date_updated=webhook.get("date_updated"),
    )


@ProjectWebhookRouter.patch("/{project_id}/webhooks/{webhook_id}")
async def update_webhook(
    project_id: str,
    webhook_id: str,
    body: WebhookUpdateRequestSchema,
    auth: DependencyDirectusSession,
) -> WebhookResponseSchema:
    """Update an existing webhook."""
    await _check_project_access(project_id, auth)

    from dembrane.directus import directus
    from dembrane.service.webhook import WEBHOOK_EVENTS

    # Validate events if provided
    if body.events is not None:
        for event in body.events:
            if event not in WEBHOOK_EVENTS:
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid event type: {event}. Valid types: {WEBHOOK_EVENTS}",
                )

    # Validate URL if provided
    if body.url is not None and not body.url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="URL must start with http:// or https://")

    # Validate status if provided
    if body.status is not None and body.status not in ("published", "draft", "archived"):
        raise HTTPException(
            status_code=400,
            detail="Status must be one of: published, draft, archived",
        )

    try:
        # Verify webhook belongs to this project
        existing = await run_in_thread_pool(
            directus.get_items,
            "project_webhook",
            {
                "query": {
                    "filter": {
                        "id": {"_eq": webhook_id},
                        "project_id": {"_eq": project_id},
                    },
                }
            },
        )
        if not existing:
            raise HTTPException(status_code=404, detail="Webhook not found")

        update_data: dict[str, Any] = {}
        if body.name is not None:
            update_data["name"] = body.name
        if body.url is not None:
            update_data["url"] = body.url
        if body.secret is not None:
            update_data["secret"] = body.secret
        if body.events is not None:
            update_data["events"] = json.dumps(body.events)
        if body.status is not None:
            update_data["status"] = body.status

        if update_data:
            await run_in_thread_pool(
                directus.update_item, "project_webhook", webhook_id, update_data
            )

        # Re-fetch the complete webhook to ensure we return all fields
        updated_webhooks = await run_in_thread_pool(
            directus.get_items,
            "project_webhook",
            {
                "query": {
                    "filter": {"id": {"_eq": webhook_id}},
                    "fields": [
                        "id",
                        "name",
                        "url",
                        "events",
                        "status",
                        "date_created",
                        "date_updated",
                    ],
                }
            },
        )
        webhook = updated_webhooks[0] if updated_webhooks else existing[0]

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to update webhook {webhook_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to update webhook") from e

    return WebhookResponseSchema(
        id=webhook.get("id"),
        name=webhook.get("name"),
        url=webhook.get("url"),
        events=_parse_webhook_events(webhook.get("events")),
        status=webhook.get("status"),
        date_created=webhook.get("date_created"),
        date_updated=webhook.get("date_updated"),
    )


@ProjectWebhookRouter.delete(
    "/{project_id}/webhooks/{webhook_id}", status_code=HTTPStatus.NO_CONTENT
)
async def delete_webhook(
    project_id: str,
    webhook_id: str,
    auth: DependencyDirectusSession,
) -> None:
    """Soft-delete a webhook by setting deleted_at."""
    await _check_project_access(project_id, auth)

    from dembrane.directus import directus

    try:
        # Verify webhook belongs to this project
        existing = await run_in_thread_pool(
            directus.get_items,
            "project_webhook",
            {
                "query": {
                    "filter": {
                        "id": {"_eq": webhook_id},
                        "project_id": {"_eq": project_id},
                    },
                }
            },
        )
        if not existing:
            raise HTTPException(status_code=404, detail="Webhook not found")

        await run_in_thread_pool(
            directus.update_item,
            "project_webhook",
            webhook_id,
            {"deleted_at": datetime.utcnow().isoformat()},
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to delete webhook {webhook_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to delete webhook") from e


@ProjectWebhookRouter.post("/{project_id}/webhooks/{webhook_id}/test")
async def test_webhook(
    project_id: str,
    webhook_id: str,
    auth: DependencyDirectusSession,
) -> WebhookTestResponseSchema:
    """
    Test a webhook by sending a sample payload.

    Sends a test event payload to the webhook URL and returns the result.
    The test payload uses the same structure as real webhook payloads.
    """
    project = await _check_project_access(project_id, auth)

    from dembrane.directus import directus
    from dembrane.service.webhook import WebhookService

    try:
        webhooks = await run_in_thread_pool(
            directus.get_items,
            "project_webhook",
            {
                "query": {
                    "filter": {
                        "id": {"_eq": webhook_id},
                        "project_id": {"_eq": project_id},
                    },
                    "fields": ["id", "name", "url", "secret", "events"],
                }
            },
        )
        if not webhooks:
            raise HTTPException(status_code=404, detail="Webhook not found")

        webhook = webhooks[0]

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to fetch webhook {webhook_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch webhook") from e

    # Build test payload using the same structure as real webhooks
    # Create a mock conversation that matches the real payload structure
    service = WebhookService()

    mock_conversation = {
        "id": "test-conversation-id",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "participant_name": "Test Participant",
        "duration": 120,
        "source": "PORTAL_AUDIO",
        "is_finished": True,
        "is_all_chunks_transcribed": True,
        "tags": [],  # Empty tags like a real conversation without tags
        "summary": "This is a test summary for webhook testing.",
    }

    # Use the service's build_payload method with "conversation.summarized"
    # to get all fields (including transcript and summary), then override event
    test_payload = service.build_payload(
        event="conversation.summarized",  # Use this to include all fields
        conversation=mock_conversation,
        project=project,
        transcript="This is a test transcript for webhook testing.",
        emails_csv="test@example.com,another@example.com",
    )

    # Override the event to indicate this is a test
    test_payload["event"] = "webhook.test"

    # Dispatch the test webhook
    try:
        status_code, response_text = await run_in_thread_pool(
            service.dispatch_webhook_sync, webhook, test_payload
        )

        if 200 <= status_code < 300:
            return WebhookTestResponseSchema(
                success=True,
                status_code=status_code,
                message=f"Webhook responded successfully with status {status_code}",
            )
        else:
            return WebhookTestResponseSchema(
                success=False,
                status_code=status_code,
                message=f"Webhook returned error status {status_code}: {response_text[:200]}",
            )

    except Exception as e:
        logger.error(f"Webhook test failed for {webhook_id}: {e}")
        return WebhookTestResponseSchema(
            success=False,
            status_code=None,
            message=f"Failed to connect to webhook: {str(e)}",
        )
