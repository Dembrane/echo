"""Canvas history objects shared by the Audit tab and agent tools."""

from __future__ import annotations

from typing import Any

from dembrane.canvas.ledgers import fresh_canvas_state
from dembrane.directus_async import async_directus


def _as_id(value: Any) -> str | None:
    if isinstance(value, dict):
        value = value.get("id")
    normalized = str(value or "").strip()
    return normalized or None


def _rows(value: Any) -> list[dict[str, Any]]:
    return [row for row in value if isinstance(row, dict)] if isinstance(value, list) else []


async def _get_rows(
    collection: str,
    query: dict[str, Any],
    *,
    directus_client: Any,
) -> list[dict[str, Any]]:
    rows = await directus_client.get_items(collection, {"query": query})
    return _rows(rows)


def _cause(
    *,
    cause_type: str,
    chat_id: Any = None,
    message_id: Any = None,
    run_chat_id: Any = None,
) -> dict[str, str | None]:
    return {
        "type": cause_type,
        "chat_id": _as_id(chat_id),
        "message_id": _as_id(message_id),
        "run_chat_id": _as_id(run_chat_id),
    }


def _detail_items(detail: Any) -> list[str]:
    text = str(detail or "").strip()
    if not text:
        return []
    return [part.strip() for part in text.split(";") if part.strip()] or [text]


def _version_map(generations: list[dict[str, Any]]) -> dict[str, int]:
    ok_generations = sorted(
        [row for row in generations if str(row.get("status") or "") == "ok"],
        key=lambda row: str(row.get("created_at") or ""),
    )
    return {
        str(row["id"]): index + 1
        for index, row in enumerate(ok_generations)
        if str(row.get("id") or "").strip()
    }


async def build_canvas_history(
    report_id: str,
    *,
    limit: int = 30,
    directus_client: Any | None = None,
) -> list[dict[str, Any]]:
    """Return normalized audit entries for a canvas report.

    The object shape is intentionally renderer-friendly and agent-friendly:
    {at, kind, version, cause, heard, changes, kept_out}. Rows are newest first.
    """
    capped_limit = max(1, min(limit, 100))
    client = directus_client or async_directus
    loop_rows = await _get_rows(
        "agent_loop",
        {
            "filter": {"report_id": {"_eq": report_id}},
            "fields": ["*"],
            "sort": ["-created_at"],
            "limit": 1,
        },
        directus_client=client,
    )
    loop = loop_rows[0] if loop_rows else {}
    loop_id = _as_id(loop.get("id"))
    run_chat_id = _as_id(loop.get("created_from_chat_id"))

    generations = await _get_rows(
        "canvas_generation",
        {
            "filter": {"report_id": {"_eq": report_id}},
            "fields": ["*"],
            "sort": ["-created_at"],
            "limit": capped_limit,
        },
        directus_client=client,
    )
    generation_versions = _version_map(generations)
    generation_by_id = {str(row.get("id")): row for row in generations if row.get("id")}

    runs: list[dict[str, Any]] = []
    if loop_id:
        runs = await _get_rows(
            "agent_loop_run",
            {
                "filter": {"loop_id": {"_eq": loop_id}},
                "fields": ["*"],
                "sort": ["-started_at"],
                "limit": capped_limit,
            },
            directus_client=client,
        )

    config_revisions = await _get_rows(
        "canvas_config_revision",
        {
            "filter": {"report_id": {"_eq": report_id}},
            "fields": ["*"],
            "sort": ["-created_at"],
            "limit": min(capped_limit, 20),
        },
        directus_client=client,
    )

    entries: list[dict[str, Any]] = []
    seen_generation_ids: set[str] = set()
    for run in runs:
        generation_id = _as_id(run.get("generation_id"))
        generation = generation_by_id.get(generation_id or "")
        if generation_id:
            seen_generation_ids.add(generation_id)
        status = str(run.get("status") or "").strip()
        no_change = status == "no_op" or not generation_id
        kind = "no change" if no_change else "run"
        detail_items = _detail_items(run.get("detail"))
        changes = ["no change — nothing new heard"] if no_change else detail_items
        entries.append(
            {
                "at": run.get("started_at") or run.get("created_at"),
                "kind": kind,
                "version": generation_versions.get(generation_id or ""),
                "cause": _cause(cause_type=str(generation.get("tick_kind") or "canvas_loop") if generation else "canvas_loop", run_chat_id=run_chat_id),
                "heard": detail_items if not no_change else [],
                "changes": changes,
                "kept_out": [item for item in detail_items if "rejected" in item.lower() or "kept out" in item.lower()],
            }
        )

    for generation in generations:
        generation_id = _as_id(generation.get("id"))
        if not generation_id or generation_id in seen_generation_ids:
            continue
        detail_items = _detail_items(generation.get("detail"))
        entries.append(
            {
                "at": generation.get("created_at"),
                "kind": "generation",
                "version": generation_versions.get(generation_id),
                "cause": _cause(cause_type=str(generation.get("tick_kind") or "generation"), run_chat_id=run_chat_id),
                "heard": detail_items,
                "changes": detail_items,
                "kept_out": [item for item in detail_items if "rejected" in item.lower() or "kept out" in item.lower()],
            }
        )

    for revision in config_revisions:
        entries.append(
            {
                "at": revision.get("created_at"),
                "kind": "config revision",
                "version": None,
                "cause": _cause(
                    cause_type=str(revision.get("note") or "brief update"),
                    chat_id=revision.get("chat_id") or revision.get("applied_from_chat_id"),
                    run_chat_id=run_chat_id,
                ),
                "heard": [],
                "changes": [str(revision.get("brief") or "").strip()[:220]]
                if str(revision.get("brief") or "").strip()
                else [],
                "kept_out": [],
            }
        )

    state = fresh_canvas_state(loop)
    for item in state.get("host_items") or []:
        if not isinstance(item, dict):
            continue
        removed = bool(item.get("removed_at"))
        entries.append(
            {
                "at": item.get("removed_at") or item.get("added_at"),
                "kind": "host item removed" if removed else "host item added",
                "version": None,
                "cause": _cause(
                    cause_type="host",
                    chat_id=item.get("chat_id"),
                    message_id=item.get("message_id"),
                    run_chat_id=run_chat_id,
                ),
                "heard": [str(item.get("text") or "").strip()] if not removed else [],
                "changes": [str(item.get("text") or "").strip()],
                "kept_out": [str(item.get("text") or "").strip()] if removed else [],
            }
        )

    return sorted(entries, key=lambda entry: str(entry.get("at") or ""), reverse=True)[:capped_limit]
