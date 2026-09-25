"""Presentation identity and defaults on the existing Popcorn report/settings row.

A presentation is independent of producer runs; no parallel storage subsystem
or schema migration is needed. Legacy sessions retain their IDs and links.
"""

from __future__ import annotations

import logging
from typing import Any
from datetime import datetime, timezone
from collections.abc import Sequence

from dembrane.popcorn import service

logger = logging.getLogger("dembrane.popcorn.present")


class DraftConflict(RuntimeError):
    """The draft moved on since the editor last read it."""


DRAFT_CONFLICT_DETAIL = "The presentation draft changed elsewhere."

# How a translation tick writes a failure into its run detail.
TRANSLATION_FAILURE_PREFIX = "translation failed: "

TRANSLATION_OFF: dict[str, Any] = {
    "target": None,
    "targets": [],
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
    from dembrane.popcorn.translate import missing_texts, popcorn_texts, translatable_texts

    targets = service.translation_targets(settings, project)
    if not targets:
        return dict(TRANSLATION_OFF)
    target = targets[0]
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
    # The first language carries the whole deck, the extra ones the popcorn
    # phrases alone. The totals are the host's one answer over all of them.
    tables = state.get("translations") or {}
    phrases = popcorn_texts(files)
    rows = []
    for index, code in enumerate(targets):
        texts = translatable_texts(files) if index == 0 else phrases
        owed = len(missing_texts(files, tables.get(code) or {}, code, texts))
        rows.append(
            {
                "target": code,
                "total": len(texts),
                "translated": len(texts) - owed,
                "pending": owed,
            }
        )
    total = sum(row["total"] for row in rows)
    pending = sum(row["pending"] for row in rows)
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
        "targets": rows,
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


async def publish_opening(
    report: dict[str, Any], *, patch: dict[str, Any], validate: Any = None
) -> dict[str, Any]:
    """Put a few words of the opening live and leave the rest of the draft alone.

    The patch is merged onto the published settings and onto the draft in one
    write, so the room reads the new words now and a later publish does not
    bring the old ones back. It merges field by field under the write lock, so
    it asks for no revision; a stored draft still moves to the next revision,
    which sends an editor open elsewhere to read it back. `validate` is awaited
    with the published settings the write would leave, before anything is stored.
    """
    async with service.settings_write_lock(str(report["id"])) as holder:
        state = await draft_state(report)
        fallback_title = str(report.get("user_instructions") or "Popcorn")
        published = service.merge_settings(state["published"], patch, fallback_title=fallback_title)
        if validate is not None:
            await validate(published)
        settings = service.merge_settings(state["settings"], patch, fallback_title=fallback_title)
        raw = state["config"].get("popcorn_settings")
        revision, saved_at = state["revision"], state["saved_at"]
        stored = dict(published)
        # Without a stored draft the draft simply reads as the published
        # settings, and keeps following them.
        if isinstance(raw, dict) and isinstance(raw.get("_present_draft"), dict):
            revision += 1
            saved_at = datetime.now(timezone.utc).isoformat()
            stored["_present_draft"] = {
                "revision": revision,
                "saved_at": saved_at,
                "settings": settings,
            }
        await service.write_settings(
            report,
            state["config"],
            stored,
            fallback_title=fallback_title,
            nudge=True,
            holder=holder,
        )
        return {
            **state,
            "published": published,
            "settings": settings,
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


def _evidence_of(detail: Any) -> list[dict[str, Any]]:
    """One detail's evidence documents, whichever shape carried them.

    A projection that kept a flat quote list instead of evidence groups is
    read the same way the host's own map view reads it, so the slots and the
    passages behind a node always agree.
    """
    detail = detail if isinstance(detail, dict) else {}
    evidence = detail.get("evidence")
    if isinstance(evidence, list):
        return [
            item for item in evidence if isinstance(item, dict) and item.get("conversationId")
        ]
    quotes = detail.get("quotes")
    if isinstance(quotes, list):
        grouped: dict[str, list[str]] = {}
        for quote in quotes:
            if isinstance(quote, dict) and quote.get("conversationId") and quote.get("text"):
                grouped.setdefault(str(quote["conversationId"]), []).append(str(quote["text"]))
        return [{"conversationId": cid, "quotes": texts} for cid, texts in grouped.items()]
    return []


def _member_details(detail: Any) -> list[dict[str, Any]]:
    """The member documents of a deduplicated argument, or nothing."""
    detail = detail if isinstance(detail, dict) else {}
    consolidation = detail.get("consolidation")
    members = consolidation.get("members") if isinstance(consolidation, dict) else None
    return [member for member in members or [] if isinstance(member, dict)]


def _node_conversations(node: dict[str, Any]) -> list[str]:
    """The conversations behind one node, one entry per contributing member.

    A merge repeats a conversation once per member that came from it, so the
    map can weight a blend of their colours; anything else names each of its
    own source conversations once.
    """

    def named(evidence: list[dict[str, Any]]) -> list[str]:
        return [str(item["conversationId"]) for item in evidence]

    detail = node.get("detail")
    detail = detail if isinstance(detail, dict) else {}
    members = _member_details(detail)
    if members:
        return [
            conversation_id
            for member in members
            for conversation_id in named(_evidence_of(member))
        ]
    return named(_evidence_of(detail))


def _audience_evidence(
    evidence: list[dict[str, Any]], slot_of: dict[str, int]
) -> list[dict[str, Any]]:
    """Evidence as the room may read it: quotes under a palette slot.

    The same shape the host payload uses, with the conversation's opaque slot
    in place of its id, and nothing else a conversation could be traced by.
    A conversation the slot map does not know contributed nothing visible and
    is dropped rather than given a colour of its own here.
    """
    grouped: dict[int, list[str]] = {}
    for item in evidence:
        slot = slot_of.get(str(item["conversationId"]))
        if slot is None:
            continue
        quotes = [
            str(quote) for quote in item.get("quotes") or [] if isinstance(quote, str) and quote
        ]
        grouped.setdefault(slot, []).extend(quotes)
    return [{"conversation": slot, "quotes": quotes} for slot, quotes in sorted(grouped.items())]


def _slot_map(
    payload: dict[str, Any], order: Sequence[str]
) -> tuple[dict[str, int], dict[str, list[int]]]:
    """The palette slot of every conversation on this map, and per node."""
    slot_of = {str(cid): index for index, cid in enumerate(order)}
    slots: dict[str, list[int]] = {}
    for node in payload.get("nodes", []):
        found = []
        for conversation_id in _node_conversations(node):
            if conversation_id not in slot_of:
                slot_of[conversation_id] = len(slot_of)
            found.append(slot_of[conversation_id])
        slots[str(node.get("revisionId"))] = sorted(found)
    return slot_of, slots


def conversation_slots(payload: dict[str, Any], order: Sequence[str]) -> dict[str, list[int]]:
    """A palette slot per conversation, per node, and nothing else about it.

    `order` is the popcorn session's own conversation order, oldest first,
    which is how the deck hands its markers out. Mirroring it here is what
    makes one conversation the same colour on the stage and on the map. A
    conversation the session does not list (a map built before it joined)
    takes the next slot after the ones it does, in first-seen order.

    The slots are the only thing the room is told about a conversation beyond
    its name, which travels separately and only where the host asked for it:
    never an id, never how many conversations one argument touched beyond its
    own colours.
    """
    return _slot_map(payload, order)[1]


def sanitize_map(
    payload: dict[str, Any],
    order: Sequence[str] = (),
    names: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Explicit audience projection: the evidence, never its sources.

    Every visible node carries its quotes as plain text under the palette slot
    of the conversation they were spoken in, and a deduplicated argument the
    same per member, in the host payload's own shape. What stays behind:
    conversation and chunk ids, timestamps, dashboard urls, provenance, actor
    ids, fact-check eligibility.

    `names` is the session's conversation labels by id, passed only when the
    presentation's names-on-the-legend setting is on. Without it no name
    leaves the server and the room numbers the conversations itself.
    """
    slot_of, slots = _slot_map(payload, order)
    nodes = []
    for node in payload.get("nodes", []):
        detail = node.get("detail") or {}
        consolidation = detail.get("consolidation") or {}
        projected: dict[str, Any] = {}
        member_count = consolidation.get("memberCount")
        if member_count:
            merged: dict[str, Any] = {"memberCount": member_count}
            members = [
                {
                    "statement": str(member.get("statement") or ""),
                    "evidence": _audience_evidence(_evidence_of(member), slot_of),
                }
                for member in _member_details(detail)
            ]
            # A lineage the projection could not read in full would leave the
            # room counting members it cannot see; the count alone is honest.
            if members and len(members) == member_count:
                merged["members"] = members
            projected["consolidation"] = merged
        evidence = _audience_evidence(_evidence_of(detail), slot_of)
        if evidence:
            projected["evidence"] = evidence
        nodes.append(
            {
                **{
                    k: node.get(k)
                    for k in ("objectId", "revisionId", "type", "label", "embedding", "attributes")
                },
                "detail": projected,
                "conversations": slots.get(str(node.get("revisionId"))) or [],
                "provenance": {},
                "factCheck": {"eligible": False},
            }
        )
    conversation_names = {
        str(slot): str(names.get(conversation_id) or "").strip()
        for conversation_id, slot in slot_of.items()
        if names and str(names.get(conversation_id) or "").strip()
    }
    return {
        "conversationNames": conversation_names,
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


async def conversation_legend(
    report: dict[str, Any] | None,
) -> tuple[list[str], dict[str, str]]:
    """The popcorn session's conversations, oldest first, with what the deck
    calls each of them.

    The order is how the deck hands its marker colours out; the names are the
    deck's own legend labels, the name typed on the phone. A conversation that
    was never named has no entry here, and the room numbers it, exactly as the
    deck's legend does. Empty where there is no session state yet; the map
    then keeps its own first-seen order."""
    if not report:
        return [], {}
    loop = await service.get_loop_for_report(str(report["id"]))
    state = service.normalize_state((loop or {}).get("popcorn_state"))
    conversations = state.get("conversations") or {}
    order = [str(cid) for cid in state.get("order") or []]
    names = {
        cid: str((conversations.get(cid) or {}).get("label") or "").strip()
        for cid in order
        if str((conversations.get(cid) or {}).get("label") or "").strip()
    }
    return order, names


async def conversation_order(report: dict[str, Any] | None) -> list[str]:
    """The popcorn session's conversation order alone; see `conversation_legend`."""
    return (await conversation_legend(report))[0]


async def audience_map(
    project_id: str,
    *,
    settings: dict[str, Any] | None = None,
    node_limit: int | None = None,
    edge_limit: int | None = None,
    report: dict[str, Any] | None = None,
) -> dict[str, Any]:
    from fastapi import HTTPException

    from dembrane.map.store import MapStoreError
    from dembrane.analysis.contracts import AnalysisStoreError

    # The host's graph endpoint answers a store failure with 503; the room's
    # screen gets the same, and keeps what it shows until the store is back.
    try:
        return await _audience_map(
            project_id,
            settings=settings,
            node_limit=node_limit,
            edge_limit=edge_limit,
            report=report,
        )
    except (MapStoreError, AnalysisStoreError) as exc:
        raise HTTPException(status_code=503, detail="Map storage is unavailable.") from exc


async def _audience_map(
    project_id: str,
    *,
    settings: dict[str, Any] | None,
    node_limit: int | None,
    edge_limit: int | None,
    report: dict[str, Any] | None = None,
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
    # The colours the room already saw on the popcorn stage, and the legend's
    # own names where the presentation says the room may read them.
    order, labels = await conversation_legend(report)
    names = labels if (settings or {}).get("public_labels") == "names" else None
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
                sanitize_map(
                    await legacy_graph_payload(row, query, store=legacy_store), order, names
                ),
                settings,
            )
            projected["fact_checks"] = audience_assessments(
                await map_service.fact_check_states(row, legacy_store), projected
            )
            return await _withdraw_map(projected, project_id, store)
    if snapshot:
        projected = _curate_map(
            sanitize_map(await graph_payload(snapshot, query, store=store), order, names),
            settings,
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
    departed revisions carried: their quotes leave inside their own node, and a
    conversation left with nothing on the map loses its name too. Fact checks
    are filtered where they are already attached; curation runs before that,
    and adds no empty key of its own."""
    if not hidden:
        return payload
    nodes = [node for node in payload.get("nodes", []) if node.get("objectId") not in hidden]
    visible = {node["revisionId"] for node in nodes}
    projected = {
        **payload,
        "nodes": nodes,
        "unplaced": [rid for rid in payload.get("unplaced") or [] if rid in visible],
    }
    if isinstance(payload.get("conversationNames"), dict):
        standing = {
            str(slot) for node in nodes for slot in node.get("conversations") or []
        }
        projected["conversationNames"] = {
            slot: name
            for slot, name in payload["conversationNames"].items()
            if slot in standing
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
