"""Presentation identity and defaults on the existing Popcorn report/settings row.

A presentation is independent of producer runs; no parallel storage subsystem
or schema migration is needed. Legacy sessions retain their IDs and links.
"""

from __future__ import annotations

import logging
from typing import Any
from datetime import datetime, timezone

from dembrane.popcorn import service

logger = logging.getLogger("dembrane.popcorn.present")


class DraftConflict(RuntimeError):
    """The draft moved on since the editor last read it."""


DRAFT_CONFLICT_DETAIL = "The presentation draft changed elsewhere."

# How a translation tick writes a failure into its run detail.
TRANSLATION_FAILURE_PREFIX = "translation failed: "

TRANSLATION_OFF: dict[str, Any] = {
    "target": None,
    "total": 0,
    "translated": 0,
    "pending": 0,
    "state": "off",
    "detail": None,
}

FALLBACK_TITLES = {
    "en": "Presentation",
    "nl": "Presentatie",
    "de": "Präsentation",
    "fr": "Présentation",
    "es": "Presentación",
    "it": "Presentazione",
    "uk": "Презентація",
    "cs": "Prezentace",
}


async def ensure_default(project: dict[str, Any], actor_id: str) -> dict[str, Any]:
    project_id = str(project["id"])
    code, _ = service.resolve_project_language(project.get("language"))
    title = str(project.get("name") or "").strip()[:160] or FALLBACK_TITLES[code]
    settings = service.default_settings(title=title)
    settings["tabs"] = {k: False for k in service.TOGGLEABLE_TABS}
    settings["presentation"] = service.normalize_presentation({"language_policy": "project"})
    # A new presentation has a useful opening before the project has produced
    # any analysis. The title is already known; the host can add supporting
    # copy later without us inventing it here.
    settings["intro"] = {"enabled": True, "title": title, "subtitle": ""}
    settings["data"] = {"enabled": True}
    settings["recipe_settings"] = {"voice": settings["voice"]}
    async with service.presentation_create_lock(project_id):
        existing = await service.get_popcorn_report(project_id)
        created = await service.create_popcorn(
            project_id=project_id,
            title=str((existing or {}).get("user_instructions") or title),
            client=None,
            acting_directus_user_id=actor_id,
            report=existing,
            initial_settings=settings,
            start_processing=False,
        )
        report = created["report"]
        if existing:
            # Preserve legacy choices and identity. A report left by a partial
            # creation receives its missing config/loop above first.
            stored = service.normalize_settings(
                created["config"].get("popcorn_settings"),
                fallback_title=str(report.get("user_instructions") or "Popcorn"),
            )
            if not stored.get("presentation"):
                blocks = ["popcorn"] + [
                    kind for kind in service.TOGGLEABLE_TABS if stored["tabs"].get(kind)
                ]
                await service.update_settings(
                    report=report,
                    patch={
                        "presentation": {
                            "blocks": blocks,
                            "opening": "popcorn",
                            "language_policy": "explicit",
                        }
                    },
                )
        return report


async def payload(report: dict[str, Any], project: dict[str, Any]) -> dict[str, Any]:
    capture: dict[str, Any] = {}
    detail = await service.popcorn_payload(report, capture=capture)
    resolved = service.resolve_presentation_settings(detail["settings"], project)
    language, fallback = service.resolve_project_language(project.get("language"))
    detail["effective_language"] = resolved["language"]
    detail["project_language"] = {"code": language, "fallback": fallback}
    detail["translation_status"] = await translation_status(
        report,
        project,
        detail["settings"],
        state=capture.get("state") or service.fresh_state(),
        run=capture.get("run"),
    )
    return detail


def _translation_failure(run: dict[str, Any] | None) -> str | None:
    """What the newest run said about a translation that did not finish.

    A run row carries no kind of its own, and a translation tick is dispatched
    the moment the host picks a language: it is the last thing to run, and the
    only run that fails under this prefix.
    """
    run = run or {}
    if run.get("status") != "error":
        return None
    detail = str(run.get("detail") or "")
    if not detail.startswith(TRANSLATION_FAILURE_PREFIX):
        return None
    return detail[len(TRANSLATION_FAILURE_PREFIX) :] or None


async def translation_status(
    report: dict[str, Any],
    project: dict[str, Any],
    settings: dict[str, Any],
    *,
    state: dict[str, Any],
    run: dict[str, Any] | None,
) -> dict[str, Any]:
    """How far the chosen translation has got, beside the language options.

    A pure read: it counts what a tick would still owe, and never dispatches
    one, calls a model or writes. A deck that cannot be read leaves the panel
    off rather than taking the whole payload down with it.
    """
    try:
        return await _translation_status(report, project, settings, state=state, run=run)
    except Exception as exc:  # noqa: BLE001
        logger.warning("present: translation status unavailable for %s (%s)", report.get("id"), exc)
        return dict(TRANSLATION_OFF)


async def _translation_status(
    report: dict[str, Any],
    project: dict[str, Any],
    settings: dict[str, Any],
    *,
    state: dict[str, Any],
    run: dict[str, Any] | None,
) -> dict[str, Any]:
    from dembrane.settings import get_settings
    from dembrane.popcorn.bundle import published_bundle
    from dembrane.popcorn.translate import missing_texts, translatable_texts

    target = service.translation_target(settings, project)
    if not target:
        return dict(TRANSLATION_OFF)
    resolved = service.resolve_presentation_settings(settings, project)
    project_id = service._as_id(project.get("id")) or service._as_id(report.get("project_id"))
    # The room's deck in its original words, the files the tick counts. Only
    # results carry translatable text, so the data screen's effective legal
    # basis is left unresolved here and costs no read of its own.
    bundle = service.build_bundle(
        state=state,
        settings=resolved,
        report=report,
        project=project,
        participant_base_url=get_settings().urls.participant_base_url,
    )
    files = (
        await published_bundle(
            bundle, project_id=project_id, settings=resolved, project=project, host=False
        )
    )["files"]
    table = (state.get("translations") or {}).get(target) or {}
    total = len(translatable_texts(files))
    pending = len(missing_texts(files, table, target))
    failure = _translation_failure(run)
    source, _fallback = service.resolve_project_language(project.get("language"))
    if target == source and not total:
        # The room is already speaking the target language and has nothing on
        # the deck; there is no translation for the host to watch.
        named = "off"
    elif not pending:
        named = "done"
    else:
        named = "incomplete" if failure else "translating"
    return {
        "target": target,
        "total": total,
        "translated": total - pending,
        "pending": pending,
        "state": named,
        "detail": failure if named == "incomplete" else None,
    }


async def draft_state(report: dict[str, Any]) -> dict[str, Any]:
    config = await service.get_latest_config(str(report["id"]))
    if not config:
        raise RuntimeError("Popcorn settings revision not found")
    fallback_title = str(report.get("user_instructions") or "Popcorn")
    raw = config.get("popcorn_settings")
    raw = raw if isinstance(raw, dict) else {}
    published = service.normalize_settings(raw, fallback_title=fallback_title)
    stored = raw.get("_present_draft")
    stored = stored if isinstance(stored, dict) else {}
    settings = service.normalize_settings(
        stored.get("settings") if isinstance(stored.get("settings"), dict) else published,
        fallback_title=fallback_title,
    )
    # Result bindings advance outside the editor when a host adopts newer
    # analysis. They are not draftable, so an older draft must not roll them back.
    if settings.get("presentation") and published.get("presentation"):
        settings["presentation"] = {
            **settings["presentation"],
            "result_bindings": published["presentation"].get("result_bindings", {}),
        }
    revision = stored.get("revision")
    revision = revision if isinstance(revision, int) and not isinstance(revision, bool) else 0
    saved_at = stored.get("saved_at")
    return {
        "config": config,
        "published": published,
        "settings": settings,
        "revision": max(0, revision),
        "saved_at": saved_at if isinstance(saved_at, str) else None,
    }


async def save_draft(
    report: dict[str, Any], *, patch: dict[str, Any], expected_revision: int
) -> dict[str, Any]:
    async with service.settings_write_lock(str(report["id"])) as holder:
        state = await draft_state(report)
        if state["revision"] != expected_revision:
            raise DraftConflict(DRAFT_CONFLICT_DETAIL)
        fallback_title = str(report.get("user_instructions") or "Popcorn")
        settings = service.merge_settings(state["settings"], patch, fallback_title=fallback_title)
        saved_at = datetime.now(timezone.utc).isoformat()
        revision = state["revision"] + 1
        raw = state["config"].get("popcorn_settings")
        raw = dict(raw) if isinstance(raw, dict) else dict(state["published"])
        raw["_present_draft"] = {
            "revision": revision,
            "saved_at": saved_at,
            "settings": settings,
        }
        # An autosave touches the draft container only: the room keeps the
        # published title and hears nothing until the host publishes.
        await service.write_config_settings(state["config"], raw, holder=holder)
        return {
            **state,
            "settings": settings,
            "revision": revision,
            "saved_at": saved_at,
        }


async def publish_draft(report: dict[str, Any], *, expected_revision: int) -> dict[str, Any]:
    async with service.settings_write_lock(str(report["id"])) as holder:
        state = await draft_state(report)
        if state["revision"] != expected_revision:
            raise DraftConflict(DRAFT_CONFLICT_DETAIL)
        saved_at = datetime.now(timezone.utc).isoformat()
        revision = state["revision"] + 1
        settings = dict(state["settings"])
        settings["_present_draft"] = {
            "revision": revision,
            "saved_at": saved_at,
            "settings": state["settings"],
        }
        await service.write_settings(
            report,
            state["config"],
            settings,
            fallback_title=str(report.get("user_instructions") or "Popcorn"),
            nudge=True,
            holder=holder,
        )
        return {
            **state,
            "published": state["settings"],
            "revision": revision,
            "saved_at": saved_at,
        }


async def draft_payload(
    report: dict[str, Any], project: dict[str, Any], settings: dict[str, Any]
) -> dict[str, Any]:
    capture: dict[str, Any] = {}
    detail = await service.popcorn_payload(report, capture=capture)
    detail["settings"] = settings
    detail["name"] = settings["title"]
    resolved = service.resolve_presentation_settings(settings, project)
    language, fallback = service.resolve_project_language(project.get("language"))
    detail["effective_language"] = resolved["language"]
    detail["project_language"] = {"code": language, "fallback": fallback}
    # The host is looking at what the draft will do, so the draft's own
    # resolved language is the target reported here.
    detail["translation_status"] = await translation_status(
        report,
        project,
        settings,
        state=capture.get("state") or service.fresh_state(),
        run=capture.get("run"),
    )
    return detail


def audience_manifest(settings: dict[str, Any]) -> dict[str, Any]:
    raw = settings.get("presentation") or {
        "blocks": ["popcorn"] + [k for k, v in settings["tabs"].items() if v],
    }
    manifest = service.normalize_presentation(raw)
    assert manifest is not None
    return {k: manifest[k] for k in ("version", "blocks", "opening")}


def sanitize_map(payload: dict[str, Any]) -> dict[str, Any]:
    """Explicit audience projection: no passages, source IDs or host detail URLs."""
    nodes = []
    for node in payload.get("nodes", []):
        detail = node.get("detail") or {}
        consolidation = detail.get("consolidation") or {}
        nodes.append(
            {
                **{
                    k: node.get(k)
                    for k in ("objectId", "revisionId", "type", "label", "embedding", "attributes")
                },
                "detail": {"consolidation": {"memberCount": consolidation["memberCount"]}}
                if consolidation.get("memberCount")
                else {},
                "provenance": {},
                "factCheck": {"eligible": False},
            }
        )
    return {
        **{
            k: payload.get(k)
            for k in (
                "version",
                "budgets",
                "counts",
                "scope",
                "overBudget",
                "embedding",
                "unplaced",
            )
        },
        "snapshot": {k: (payload.get("snapshot") or {}).get(k) for k in ("id", "createdAt")},
        "nodes": nodes,
        # No semantic relations are implied by the audience's spatial layout.
        "relations": [],
        "related": [],
    }


async def audience_map(
    project_id: str,
    *,
    settings: dict[str, Any] | None = None,
    node_limit: int | None = None,
    edge_limit: int | None = None,
) -> dict[str, Any]:
    from fastapi import HTTPException

    from dembrane.map.store import MapStoreError
    from dembrane.analysis.contracts import AnalysisStoreError

    # The host's graph endpoint answers a store failure with 503; the room's
    # screen gets the same, and keeps what it shows until the store is back.
    try:
        return await _audience_map(
            project_id, settings=settings, node_limit=node_limit, edge_limit=edge_limit
        )
    except (MapStoreError, AnalysisStoreError) as exc:
        raise HTTPException(status_code=503, detail="Map storage is unavailable.") from exc


async def _audience_map(
    project_id: str,
    *,
    settings: dict[str, Any] | None,
    node_limit: int | None,
    edge_limit: int | None,
) -> dict[str, Any]:
    from fastapi import HTTPException

    from dembrane.map import service as map_service
    from dembrane.map.store import SqlMapStore
    from dembrane.analysis.store import SqlAnalysisStore
    from dembrane.analysis.budgets import BudgetError, resolve_budgets
    from dembrane.analysis.map_view import (
        GraphQuery,
        SqlMapViewReads,
        graph_payload,
        current_map_snapshot,
        legacy_graph_payload,
    )

    try:
        query = GraphQuery(types=None, scope=None, budgets=resolve_budgets(node_limit, edge_limit))
    except BudgetError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    store, reads = SqlAnalysisStore(), SqlMapViewReads()
    # Audience reads never advance a snapshot or trigger any processing.
    bound = ((settings or {}).get("presentation") or {}).get("result_bindings", {}).get("map")
    snapshot = (
        await store.get_snapshot(bound)
        if bound
        else await current_map_snapshot(project_id, store=store, reads=reads, follow=False)
    )
    if snapshot and snapshot.project_id != project_id:
        raise HTTPException(status_code=404, detail="Map results are not available.")
    legacy = [link for link in await reads.legacy_results(project_id) if not link.snapshot_id]
    newest = legacy[-1] if legacy else None
    if (
        not bound
        and newest
        and (
            snapshot is None
            or (
                newest.created_at
                and snapshot.created_at
                and newest.created_at > snapshot.created_at
            )
        )
    ):
        legacy_store = SqlMapStore()
        row = await legacy_store.get_result(newest.id)
        if row:
            projected = _curate_map(
                sanitize_map(await legacy_graph_payload(row, query, store=legacy_store)), settings
            )
            projected["fact_checks"] = audience_assessments(
                await map_service.fact_check_states(row, legacy_store), projected
            )
            return await _withdraw_map(projected, project_id, store)
    if snapshot:
        projected = _curate_map(
            sanitize_map(await graph_payload(snapshot, query, store=store)), settings
        )
        # Read only the assessments pinned to these exact revisions. No cold
        # cache or audience interaction can start a factual check.
        pinned = {
            str(a["targetRevisionId"]): str(a["revisionId"])
            for a in snapshot.manifest.get("assessments") or []
        }
        assessments = (
            await store.get_revisions(project_id, list(set(pinned.values()))) if pinned else {}
        )
        from dembrane.map.service import assessment_state

        projected["fact_checks"] = audience_assessments(
            {
                target: assessment_state(assessments[rid])
                for target, rid in pinned.items()
                if rid in assessments
            },
            projected,
        )
        return await _withdraw_map(projected, project_id, store)
    raise HTTPException(status_code=404, detail="Map results are not ready.")


async def available_bindings(report: dict[str, Any], project_id: str) -> dict[str, str]:
    from dembrane.analysis.store import SqlAnalysisStore
    from dembrane.popcorn.bundle import current_deck_snapshot, assemble_deck_snapshot
    from dembrane.analysis.map_view import SqlMapViewReads, current_map_snapshot
    from dembrane.analysis.contracts import AnalysisStoreError

    versions = await service.list_versions(str(report["id"]), limit=1)
    bindings = (
        {block: str(versions[0]["id"]) for block in ("stakeholders", "tensions")}
        if versions
        else {}
    )
    try:
        analysis_store = SqlAnalysisStore()
        deck = await current_deck_snapshot(project_id, store=analysis_store)
        if deck is None:
            deck = await assemble_deck_snapshot(project_id, store=analysis_store)
        if deck:
            available_recipes = {
                str(producer.get("recipeId"))
                for producer in deck.manifest.get("producers") or []
                if producer.get("available")
            }
            if "tensions" in available_recipes:
                bindings["tensions"] = f"analysis:{deck.id}"
            if "stakeholders" in available_recipes:
                bindings["stakeholders"] = f"analysis:{deck.id}"
        snapshot = await current_map_snapshot(
            project_id, store=analysis_store, reads=SqlMapViewReads(), follow=False
        )
        if snapshot:
            bindings["map"] = snapshot.id
    except AnalysisStoreError:
        pass  # Unavailable Map must not stop a ready Popcorn presentation.
    return bindings


async def adopt_results(
    report: dict[str, Any], project_id: str, *, initial_only: bool = False
) -> None:
    # Looking for results reads the analysis store and can take a while, so it
    # happens outside the lock. What is bound now, and so what an initial
    # adoption may still fill in, is read inside it: a binding the host adopted
    # meanwhile is never replaced by an older one found before it.
    available = await available_bindings(report, project_id)
    if not available:
        return
    async with service.settings_write_lock(str(report["id"])) as holder:
        manifest = (await service.load_settings_for(report)).get("presentation") or {}
        current = manifest.get("result_bindings") or {}
        updates = {
            block: identity
            for block, identity in available.items()
            if block in manifest.get("blocks", [])
            and current.get(block) != identity
            and (not initial_only or block not in current)
        }
        if updates:
            await service._update_settings_unlocked(
                report=report,
                patch={"presentation": {"result_bindings": updates}},
                holder=holder,
            )


def _without_nodes(payload: dict[str, Any], hidden: set[str]) -> dict[str, Any]:
    """`payload` without the hidden objects' nodes, and without what only the
    departed revisions carried. Fact checks are filtered where they are already
    attached; curation runs before that, and adds no empty key of its own."""
    if not hidden:
        return payload
    nodes = [node for node in payload.get("nodes", []) if node.get("objectId") not in hidden]
    visible = {node["revisionId"] for node in nodes}
    projected = {
        **payload,
        "nodes": nodes,
        "unplaced": [rid for rid in payload.get("unplaced") or [] if rid in visible],
    }
    if "fact_checks" in payload:
        projected["fact_checks"] = {
            rid: state for rid, state in (payload["fact_checks"] or {}).items() if rid in visible
        }
    return projected


def _curate_map(payload: dict[str, Any], settings: dict[str, Any] | None) -> dict[str, Any]:
    hidden = set(((settings or {}).get("presentation") or {}).get("hidden_items") or [])
    return _without_nodes(payload, hidden)


async def _withdraw_map(payload: dict[str, Any], project_id: str, store: Any) -> dict[str, Any]:
    from dembrane.analysis.snapshots import excluded_object_ids

    return _without_nodes(payload, await excluded_object_ids(project_id, store=store))


def audience_assessments(states: dict[str, Any], graph: dict[str, Any]) -> dict[str, Any]:
    visible = {node["revisionId"] for node in graph.get("nodes") or []}
    return {
        rid: {
            "status": "done",
            "verdict": state["verdict"],
            "justification": str(state.get("justification") or ""),
            "checkedAt": state.get("checkedAt"),
            "sources": [],
        }
        for rid, state in states.items()
        if rid in visible
        and state.get("status") == "done"
        and state.get("verdict") in ("true", "false", "contested", "unknown")
    }
