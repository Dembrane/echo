"""Fact-checks for Map claims.

One state per claim revision (statement plus evidence) per project, shared by
every renderer and panel. The API moves a claim to processing and dispatches a
worker; the worker investigates with search grounding and writes the verdict
only if its attempt is still the current one, so a cancelled or superseded
check that finishes late changes nothing. An execution failure is an error
state, never an `unknown` verdict.
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Awaitable

from dembrane.map.store import MapStore, SqlMapStore

logger = logging.getLogger("dembrane.map.fact_check")

# A check still processing after this long is treated as abandoned (its worker
# died), and a new request may start it again.
STALE_SECONDS = 15 * 60
# A worker holds its attempt against a second delivery of the same message for
# a little longer than the actor may run (task_map_fact_check's time limit is
# ten minutes), so a duplicate never pays for a second search.
ACQUIRE_SECONDS = 11 * 60


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def fact_check_state(row: dict[str, Any] | None) -> dict[str, Any]:
    """The prototype's FactCheckState shape, from a stored row."""
    if not row:
        return {"status": "idle"}
    status = row.get("status")
    if status == "processing":
        return {"status": "processing", "startedAt": _iso(row.get("started_at"))}
    if status == "done":
        return {
            "status": "done",
            "verdict": row.get("verdict") or "unknown",
            "justification": row.get("justification") or "",
            "sources": row.get("sources") or [],
            "checkedAt": _iso(row.get("completed_at")),
        }
    if status == "error":
        return {
            "status": "error",
            "message": row.get("error") or "The fact-check failed.",
            "at": _iso(row.get("completed_at") or row.get("updated_at")),
        }
    return {"status": "idle"}


def find_argument(manifest: dict[str, Any] | None, node_id: str) -> dict[str, Any] | None:
    for argument in (manifest or {}).get("arguments") or []:
        if argument.get("id") == node_id:
            return argument
    return None


async def _project_context(project_id: str) -> tuple[str, str]:
    from dembrane.directus_async import async_directus

    project = await async_directus.get_item("project", project_id) or {}
    return str(project.get("name") or ""), str(project.get("context") or "")


async def acquire_attempt(fact_check_id: str, attempt: int, redis: Any | None = None) -> bool:
    """Take one attempt for this worker. False when another delivery of the
    same message already took it. When Redis cannot answer, the check runs: the
    attempt guard on the verdict still keeps a single result."""
    key = f"map:fact_check:{fact_check_id}:{attempt}:worker"
    try:
        if redis is None:
            from dembrane.redis_async import get_redis_client

            redis = await get_redis_client()
        return bool(await redis.set(key, "1", nx=True, ex=ACQUIRE_SECONDS))
    except Exception as exc:
        logger.warning(
            "map fact-check %s attempt %s: could not acquire it (%s), running anyway",
            fact_check_id,
            attempt,
            type(exc).__name__,
        )
        return True


async def mark_interrupted(
    fact_check_id: str, attempt: int, *, store: MapStore | None = None
) -> bool:
    """A worker that lost its check (the loop was reset, the time limit hit)
    leaves an error for this attempt instead of a check stuck processing."""
    store = store or SqlMapStore()
    return await store.fail_fact_check(
        fact_check_id, attempt, "The fact-check was interrupted. Try again."
    )


async def run_fact_check(
    fact_check_id: str,
    attempt: int,
    result_id: str,
    node_id: str,
    *,
    store: MapStore | None = None,
    check: Callable[..., Awaitable[dict[str, Any]]] | None = None,
    project_context: Callable[[str], Awaitable[tuple[str, str]]] | None = None,
    publish: Callable[[str, dict[str, Any]], Awaitable[None]] | None = None,
    redis: Any | None = None,
) -> str:
    """Run one attempt. Returns done, error or stale."""
    from dembrane.map import model
    from dembrane.map.events import publish_map_event

    store = store or SqlMapStore()
    check = check or model.factcheck_claim
    project_context = project_context or _project_context
    publish = publish or publish_map_event

    row = await store.get_fact_check(fact_check_id)
    if not row or row["status"] != "processing" or int(row["attempt"]) != int(attempt):
        return "stale"
    project_id = row["project_id"]
    result = await store.get_result(result_id)
    argument = find_argument((result or {}).get("manifest"), node_id)
    if (
        not result
        or result["project_id"] != project_id
        or not argument
        or argument.get("claim_key") != row["claim_key"]
    ):
        written = await store.fail_fact_check(
            fact_check_id, attempt, "The claim is no longer part of this map."
        )
        return "error" if written else "stale"

    if not await acquire_attempt(fact_check_id, attempt, redis):
        logger.info("map fact-check %s attempt %s is already running", fact_check_id, attempt)
        return "stale"

    evidence = [quote for item in argument.get("evidence") or [] for quote in item.get("quotes") or []]
    event = {"type": "fact_check", "claim_key": row["claim_key"]}
    try:
        name, context = await project_context(project_id)
        outcome = await check(
            statement=argument["statement"],
            evidence=evidence,
            project_name=name,
            project_context=context,
        )
    except Exception as exc:
        logger.warning(
            "map fact-check %s attempt %s failed: %s", fact_check_id, attempt, type(exc).__name__
        )
        written = await store.fail_fact_check(
            fact_check_id, attempt, "The fact-check could not finish. Try again."
        )
        if written:
            await publish(project_id, event)
        return "error" if written else "stale"

    written = await store.complete_fact_check(
        fact_check_id,
        attempt,
        verdict=outcome["verdict"],
        justification=outcome["justification"],
        sources=outcome.get("sources") or [],
        model=model.model_identity(),
        prompt_version=model.FACTCHECK_PROMPT_VERSION,
    )
    if written:
        await publish(project_id, event)
        logger.info(
            "map fact-check %s attempt %s: %s with %d sources",
            fact_check_id,
            attempt,
            outcome["verdict"],
            len(outcome.get("sources") or []),
        )
        return "done"
    logger.info("map fact-check %s attempt %s finished after it was superseded", fact_check_id, attempt)
    return "stale"
