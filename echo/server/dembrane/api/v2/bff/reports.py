"""BFF endpoints for project_report + project_report_metric.

Route prefix: /v2/bff/reports (+ /v2/bff/report-metrics).

Reads gated on report:view, writes on report:generate/report:delete per
matrix §4. Metric inserts are gated by report:view — metric rows track
consumption events (e.g. portal views) and should record whenever the
caller can see the report.
"""

from __future__ import annotations

from typing import Optional
from logging import getLogger

from fastapi import Query, APIRouter, HTTPException
from pydantic import BaseModel

from dembrane.utils import generate_uuid
from dembrane.directus_async import async_directus
from dembrane.api.v2.bff._access import (
    resolve_report_access,
    filter_exclude_deleted,
    resolve_project_access,
)
from dembrane.api.dependency_auth import DependencyDirectusSession

router = APIRouter()
metric_router = APIRouter()
logger = getLogger("api.v2.bff.reports")


# ── /v2/bff/reports ───────────────────────────────────────────────────


@router.get("")
async def list_reports(
    auth: DependencyDirectusSession,
    project_id: str = Query(...),
    fields: Optional[str] = Query(
        None,
        description="Comma-separated field list. Defaults to a lean set.",
    ),
    limit: int = Query(1000, ge=1, le=1000),
) -> list[dict]:
    """List reports for a project."""
    access = await resolve_project_access(project_id, auth)
    access.require("report:view")

    default_fields = [
        "id",
        "date_created",
        "project_id",
        "status",
        "language",
        "show_portal_link",
        "error_code",
        "error_message",
        "scheduled_at",
        "user_instructions",
    ]
    field_list = (
        [f.strip() for f in fields.split(",") if f.strip()]
        if fields
        else default_fields
    )
    filt = filter_exclude_deleted({"project_id": {"_eq": project_id}})

    rows = await async_directus.get_items(
        "project_report",
        {
            "query": {
                "filter": filt,
                "fields": field_list,
                "sort": ["date_created"],
                "limit": limit,
            }
        },
    )
    return rows if isinstance(rows, list) else []


@router.get("/{report_id}")
async def get_report(
    report_id: str,
    auth: DependencyDirectusSession,
    include_content: bool = Query(True),
) -> dict:
    """Read a report. `content` is large; toggle with include_content."""
    _access, report = await resolve_report_access(report_id, auth)
    if not include_content:
        report.pop("content", None)
    return report


@router.get("/{report_id}/timeline")
async def get_report_timeline(
    report_id: str,
    auth: DependencyDirectusSession,
) -> dict:
    """Bundle payload for the report timeline view.

    Returns the report + sibling reports in the project + project
    created_at + conversation list + per-conversation chunk counts +
    the report's sibling metrics. Replaces the 6-query sequence the
    frontend used to run directly against Directus.
    """
    _access, report = await resolve_report_access(report_id, auth)
    project_id = report.get("project_id")
    if not project_id:
        raise HTTPException(status_code=404, detail="Report has no project_id")
    # project_id may come back as an id or a relation dict.
    project_id_str = (
        project_id if isinstance(project_id, str) else project_id.get("id")
    )

    all_reports_raw = await async_directus.get_items(
        "project_report",
        {
            "query": {
                "filter": filter_exclude_deleted(
                    {"project_id": {"_eq": project_id_str}}
                ),
                "fields": ["id", "date_created"],
                "sort": ["date_created"],
                "limit": 1000,
            }
        },
    ) or []
    all_reports = all_reports_raw if isinstance(all_reports_raw, list) else []

    project = await async_directus.get_item("project", project_id_str)
    project_created_at = (project or {}).get("created_at")

    convs_raw = await async_directus.get_items(
        "conversation",
        {
            "query": {
                "filter": filter_exclude_deleted(
                    {"project_id": {"_eq": project_id_str}}
                ),
                "fields": ["id", "created_at"],
                "limit": 1000,
            }
        },
    ) or []
    convs = convs_raw if isinstance(convs_raw, list) else []

    chunk_counts: dict[str, int] = {}
    if convs:
        conv_ids = [c["id"] for c in convs]
        agg = await async_directus.get_items(
            "conversation_chunk",
            {
                "query": {
                    "aggregate": {"count": "id"},
                    "groupBy": ["conversation_id"],
                    "filter": {"conversation_id": {"_in": conv_ids}},
                }
            },
        ) or []
        if isinstance(agg, list):
            for row in agg:
                cid = row.get("conversation_id")
                cnt = int((row.get("count") or {}).get("id", 0) or 0)
                if cid:
                    chunk_counts[cid] = cnt

    metrics = await async_directus.get_items(
        "project_report_metric",
        {
            "query": {
                "filter": {
                    "project_report_id": {
                        "project_id": {"_eq": project_id_str},
                    }
                },
                "fields": ["id", "date_created", "project_report_id"],
                "sort": ["date_created"],
                "limit": 1000,
            }
        },
    ) or []

    return {
        "report": {
            "id": report["id"],
            "date_created": report.get("date_created"),
            "project_id": project_id_str,
        },
        "all_reports": [
            {"id": r["id"], "date_created": r.get("date_created")}
            for r in all_reports
        ],
        "project_created_at": project_created_at,
        "conversations": [
            {
                "id": c["id"],
                "created_at": c.get("created_at"),
                "chunk_count": chunk_counts.get(c["id"], 0),
            }
            for c in convs
        ],
        "metrics": metrics if isinstance(metrics, list) else [],
    }


# ── /v2/bff/report-metrics ────────────────────────────────────────────


@metric_router.get("")
async def list_metrics(
    auth: DependencyDirectusSession,
    report_id: str = Query(...),
) -> list[dict]:
    """List metric rows for a report."""
    await resolve_report_access(report_id, auth)
    rows = await async_directus.get_items(
        "project_report_metric",
        {
            "query": {
                "filter": {"project_report_id": {"_eq": report_id}},
                "fields": ["id", "date_created", "project_report_id", "type"],
                "sort": ["date_created"],
                "limit": 1000,
            }
        },
    )
    return rows if isinstance(rows, list) else []


class ReportMetricCreate(BaseModel):
    project_report_id: str
    type: str
    ip: Optional[str] = None


@metric_router.post("")
async def create_metric(
    body: ReportMetricCreate,
    auth: DependencyDirectusSession,
) -> dict:
    """Record a report metric (e.g. portal view)."""
    await resolve_report_access(body.project_report_id, auth)
    payload: dict = {
        "id": generate_uuid(),
        "project_report_id": body.project_report_id,
        "type": body.type,
    }
    if body.ip is not None:
        payload["ip"] = body.ip
    created = await async_directus.create_item("project_report_metric", payload)
    if isinstance(created, dict) and "data" in created:
        return created["data"]
    return created or {}
