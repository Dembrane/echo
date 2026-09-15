"""Map as the API uses it: page state, generation requests, titles, fact-checks.

Every function here assumes the caller already checked access to the project
the row belongs to.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from typing import Any, Callable, Awaitable

from dembrane.map import recipe
from dembrane.map.store import ACTIVE_STATUSES, MapStore, ActiveAttemptExists
from dembrane.map.events import publish_map_event
from dembrane.map.fact_check import STALE_SECONDS as FACT_CHECK_STALE_SECONDS, fact_check_state

logger = logging.getLogger("dembrane.map.service")

# An attempt whose worker has not written progress for this long is dead.
STALE_ATTEMPT_SECONDS = 20 * 60
TITLE_CACHE_SECONDS = 7 * 24 * 3600
TITLE_LOCK_SECONDS = 90
TITLE_WAIT_SECONDS = 60.0

Dispatch = Callable[..., str]


class NotReady(Exception):
    """The result is not a ready revision."""


class UnknownArguments(ValueError):
    pass


class NotAClaim(ValueError):
    pass


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def attempt_payload(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if not row:
        return None
    progress = row.get("progress") or {}
    return {
        "id": row["id"],
        "status": row["status"],
        "created_at": _iso(row.get("created_at")),
        "updated_at": _iso(row.get("updated_at")),
        "completed_at": _iso(row.get("completed_at")),
        "error": row.get("error"),
        "progress": {
            key: progress.get(key)
            for key in (
                "stage",
                "conversations_total",
                "conversations_done",
                "conversations_failed",
                "conversations_resumed",
                "embeddings_total",
                "embeddings_done",
                "embeddings_reused",
            )
            if key in progress
        },
    }


async def result_payload(row: dict[str, Any], store: MapStore) -> dict[str, Any]:
    """A ready revision with every argument, its evidence and its vector."""
    manifest = row.get("manifest") or {}
    arguments = manifest.get("arguments") or []
    vectors = await store.vectors_by_ids(
        row["project_id"], [a["embedding_id"] for a in arguments if a.get("embedding_id")]
    )
    shaped = []
    missing = []
    for argument in arguments:
        vector = vectors.get(argument.get("embedding_id") or "")
        if vector is None:
            missing.append(argument["id"])
        shaped.append(
            {
                "id": argument["id"],
                "statement": argument["statement"],
                "kind": argument["kind"],
                "valence": argument["valence"],
                "claim_key": argument.get("claim_key"),
                "evidence": argument.get("evidence") or [],
                "created_at": argument.get("created_at"),
                "embedding": [round(value, 6) for value in vector] if vector is not None else None,
            }
        )
    config = row.get("embedding_config") or {}
    return {
        "id": row["id"],
        "status": row["status"],
        "created_at": _iso(row.get("created_at")),
        "completed_at": _iso(row.get("completed_at")),
        "recipe_version": row.get("recipe_version"),
        "source_fingerprint": row.get("source_fingerprint"),
        "embedding": {
            "model": config.get("model"),
            "dims": config.get("dims"),
            "key": config.get("key"),
        },
        "stats": manifest.get("stats") or {},
        "conversations": manifest.get("conversations") or [],
        "arguments": shaped,
        "missing_embeddings": missing,
    }


async def project_rows(
    project_id: str, store: MapStore
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """The current ready revision, and an attempt newer than it (running or failed)."""
    await store.expire_stale(project_id, STALE_ATTEMPT_SECONDS)
    current = await store.latest_ready(project_id)
    latest = await store.latest_attempt(project_id)
    attempt = None
    if (
        latest
        and latest["status"] in (*ACTIVE_STATUSES, "failed")
        and (not current or latest["created_at"] > current["created_at"])
    ):
        attempt = latest
    return current, attempt


async def state_payload(
    current: dict[str, Any] | None, attempt: dict[str, Any] | None, store: MapStore
) -> dict[str, Any]:
    return {
        "current": await result_payload(current, store) if current else None,
        "attempt": attempt_payload(attempt),
    }


async def project_state(project_id: str, store: MapStore) -> dict[str, Any]:
    current, attempt = await project_rows(project_id, store)
    return await state_payload(current, attempt, store)


def state_etag(
    current: dict[str, Any] | None,
    attempt: dict[str, Any] | None,
    conversations_with_transcripts: int | None,
) -> str:
    """Names everything the project map response is built from. A ready revision
    never changes, so its id and completion time stand for its arguments and
    vectors; an attempt changes as it moves."""
    parts = [
        str(recipe.MANIFEST_VERSION),
        f"{(current or {}).get('id')}:{_iso((current or {}).get('completed_at'))}",
        f"{(attempt or {}).get('id')}:{(attempt or {}).get('status')}:"
        f"{_iso((attempt or {}).get('updated_at'))}",
        str(conversations_with_transcripts),
    ]
    digest = hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()[:24]
    return f'W/"map-{digest}"'


def dispatch_generation(result_id: str) -> str:
    from dembrane.tasks import task_map_generate

    return task_map_generate.send(result_id).message_id


def dispatch_fact_check(fact_check_id: str, attempt: int, result_id: str, node_id: str) -> str:
    from dembrane.tasks import task_map_fact_check

    return task_map_fact_check.send(fact_check_id, attempt, result_id, node_id).message_id


async def request_generation(
    project_id: str,
    requested_by: str | None,
    *,
    store: MapStore,
    dispatch: Dispatch | None = None,
) -> dict[str, Any]:
    """Start a generation, or return the one already running.

    A failed latest attempt of the same recipe resumes: its saved extractions
    and every stored vector are reused. At most one attempt runs per project."""
    await store.expire_stale(project_id, STALE_ATTEMPT_SECONDS)
    active = await store.active_attempt(project_id)
    if active:
        return active
    row: dict[str, Any] | None = None
    latest = await store.latest_attempt(project_id)
    try:
        if (
            latest
            and latest["status"] == "failed"
            and latest.get("recipe_version") == recipe.RECIPE_VERSION
        ):
            row = await store.requeue(latest["id"])
        if row is None:
            row = await store.create_attempt(
                project_id=project_id,
                recipe_version=recipe.RECIPE_VERSION,
                requested_by=requested_by,
            )
    except ActiveAttemptExists as exc:
        return exc.row or await store.active_attempt(project_id) or {}
    try:
        # Looked up at call time, so tests can patch the module-level dispatcher.
        await store.set_execution_ref(row["id"], (dispatch or dispatch_generation)(row["id"]))
    except Exception as exc:
        logger.error("map generation %s could not be dispatched: %s", row["id"], exc)
        await store.fail(row["id"], "The generation could not be started.")
        raise
    await publish_map_event(project_id, {"type": "queued", "result_id": row["id"]})
    return row


def _ready(row: dict[str, Any]) -> dict[str, Any]:
    if row.get("status") != "ready":
        raise NotReady()
    return row.get("manifest") or {}


async def selection_title(
    row: dict[str, Any],
    node_ids: list[str],
    *,
    project_name: str,
    project_context: str,
    store: MapStore,
    redis: Any,
    generate: Callable[..., Awaitable[str]] | None = None,
) -> dict[str, Any]:
    """One title per (revision, selection, prompt and model), generated once.

    The whole selection goes to the model or the request is refused: a
    selection too large for the prompt is an error, never a partial summary."""
    from dembrane.map.model import TITLE_PROMPT, model_identity, title_selection

    manifest = _ready(row)
    by_id = {a["id"]: a for a in manifest.get("arguments") or []}
    ordered_ids = list(dict.fromkeys(node_ids))
    unknown = [node_id for node_id in ordered_ids if node_id not in by_id]
    if unknown:
        raise UnknownArguments(f"{len(unknown)} selected arguments are not in this map")
    selected = [by_id[node_id] for node_id in ordered_ids]
    claim_keys = [a["claim_key"] for a in selected if a.get("claim_key")]
    checks = await store.fact_checks_for(row["project_id"], claim_keys)
    verdicts = {
        key: check.get("verdict") for key, check in checks.items() if check.get("status") == "done"
    }
    lines = recipe.title_lines(selected, verdicts)

    config = f"{TITLE_PROMPT}|{model_identity()}"
    key = "map:title:" + recipe.title_selection_key(row["id"], ordered_ids, config)
    cached = await redis.get(key)
    if cached:
        return {"title": cached.decode() if isinstance(cached, bytes) else str(cached), "cached": True}

    lock_key = f"{key}:lock"
    owns_lock = bool(await redis.set(lock_key, "1", nx=True, ex=TITLE_LOCK_SECONDS))
    if not owns_lock:
        # Another request is generating this exact title: wait for its answer.
        waited = 0.0
        while waited < TITLE_WAIT_SECONDS:
            await asyncio.sleep(0.5)
            waited += 0.5
            cached = await redis.get(key)
            if cached:
                text = cached.decode() if isinstance(cached, bytes) else str(cached)
                return {"title": text, "cached": True}
            if not await redis.exists(lock_key):
                break
    try:
        title = await (generate or title_selection)(
            lines=lines, project_name=project_name, project_context=project_context
        )
        await redis.set(key, title, ex=TITLE_CACHE_SECONDS)
        return {"title": title, "cached": False}
    finally:
        if owns_lock:
            await redis.delete(lock_key)


async def fact_check_states(row: dict[str, Any], store: MapStore) -> dict[str, dict[str, Any]]:
    manifest = _ready(row)
    claims = [a for a in manifest.get("arguments") or [] if a.get("claim_key")]
    stored = await store.fact_checks_for(row["project_id"], [a["claim_key"] for a in claims])
    return {a["id"]: fact_check_state(stored.get(a["claim_key"])) for a in claims}


def _claim(row: dict[str, Any], node_id: str) -> dict[str, Any]:
    manifest = _ready(row)
    for argument in manifest.get("arguments") or []:
        if argument.get("id") == node_id:
            if argument.get("kind") != "claim" or not argument.get("claim_key"):
                raise NotAClaim("only claims are fact-checked")
            return argument
    raise UnknownArguments("the argument is not in this map")


async def start_fact_check(
    row: dict[str, Any],
    node_id: str,
    *,
    requested_by: str | None,
    force: bool,
    store: MapStore,
    dispatch: Dispatch | None = None,
) -> dict[str, Any]:
    """Start (or join) the check of one claim revision.

    Both renderers and the panel share one state: a second request for a claim
    that is already processing returns that state and dispatches nothing."""
    argument = _claim(row, node_id)
    check, should_dispatch = await store.start_fact_check(
        project_id=row["project_id"],
        claim_key=argument["claim_key"],
        statement=argument["statement"],
        requested_by=requested_by,
        force=force,
        stale_seconds=FACT_CHECK_STALE_SECONDS,
    )
    if should_dispatch:
        try:
            (dispatch or dispatch_fact_check)(check["id"], int(check["attempt"]), row["id"], node_id)
        except Exception as exc:
            logger.error("map fact-check %s could not be dispatched: %s", check["id"], exc)
            await store.fail_fact_check(
                check["id"], int(check["attempt"]), "The fact-check could not be started."
            )
            raise
        await publish_map_event(
            row["project_id"], {"type": "fact_check", "claim_key": argument["claim_key"]}
        )
    return fact_check_state(check)


async def cancel_fact_check(row: dict[str, Any], node_id: str, *, store: MapStore) -> dict[str, Any]:
    argument = _claim(row, node_id)
    check = await store.cancel_fact_check(row["project_id"], argument["claim_key"])
    await publish_map_event(
        row["project_id"], {"type": "fact_check", "claim_key": argument["claim_key"]}
    )
    return fact_check_state(check)
