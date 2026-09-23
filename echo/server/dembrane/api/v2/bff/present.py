"""Independent Present entry points; read-only audience projections."""

from __future__ import annotations

from typing import Any

from fastapi import Depends, Request, APIRouter, HTTPException
from pydantic import Field, BaseModel, ConfigDict

from dembrane.popcorn import present, service
from dembrane.popcorn.bundle import bundle_for_report
from dembrane.api.feature_flags import require_present_enabled
from dembrane.api.v2.bff._access import resolve_project_access
from dembrane.api.v2.bff.popcorn import (
    PopcornSettingsBody,
    _rate_limit,
    _require_popcorn,
)
from dembrane.api.dependency_auth import DependencyDirectusSession

router = APIRouter(dependencies=[Depends(require_present_enabled)])


class DraftPatchBody(BaseModel):
    patch: PopcornSettingsBody
    expected_revision: int = Field(ge=0)


class DraftPublishBody(BaseModel):
    expected_revision: int = Field(ge=0)


class OpeningIntroWords(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str | None = Field(default=None, max_length=160)
    subtitle: str | None = Field(default=None, max_length=600)


class OpeningDisclosureWords(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str | None = Field(default=None, max_length=600)
    invitation_title: str | None = Field(default=None, max_length=160)
    invitation_text: str | None = Field(default=None, max_length=600)


class OpeningWordsPatch(BaseModel):
    """The words a host may type on the slide itself, and nothing else."""

    model_config = ConfigDict(extra="forbid")
    intro: OpeningIntroWords | None = None
    disclosure: OpeningDisclosureWords | None = None


class OpeningPublishBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    patch: OpeningWordsPatch


async def _draft_envelope(
    report: dict[str, Any], project: dict[str, Any], state: dict[str, Any]
) -> dict[str, Any]:
    envelope = {
        "presentation": await present.draft_payload(report, project, state["settings"]),
        "revision": state["revision"],
        "has_changes": state["settings"] != state["published"],
    }
    if state.get("saved_at"):
        envelope["saved_at"] = state["saved_at"]
    return envelope


def _require_draft_revision(state: dict[str, Any], expected_revision: int) -> None:
    if state["revision"] != expected_revision:
        raise HTTPException(status_code=409, detail=present.DRAFT_CONFLICT_DETAIL)


async def _validate_draft_settings(
    report: dict[str, Any], access: Any, settings: dict[str, Any]
) -> None:
    try:
        service.require_branding_tier(
            str(access.tier or "free"), removes_branding=settings.get("show_branding") is False
        )
        await service.require_unlocked_frame(
            report, await service.get_loop_for_report(str(report["id"])), proposed=settings
        )
    except service.BrandingTierRequired as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except service.SyntheticFrameLocked as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/{presentation_id}/draft")
async def get_draft(presentation_id: str, auth: DependencyDirectusSession) -> dict[str, Any]:
    report, access = await _require_popcorn(presentation_id, auth)
    access.require("project:update")
    return await _draft_envelope(report, access.project, await present.draft_state(report))


@router.patch("/{presentation_id}/draft")
async def patch_draft(
    presentation_id: str, body: DraftPatchBody, auth: DependencyDirectusSession
) -> dict[str, Any]:
    report, access = await _require_popcorn(presentation_id, auth)
    access.require("project:update")
    patch = service.expand_settings_patch(body.patch.model_dump(exclude_none=True))
    current = await present.draft_state(report)
    _require_draft_revision(current, body.expected_revision)
    candidate = service.merge_settings(
        current["settings"],
        patch,
        fallback_title=str(report.get("user_instructions") or "Popcorn"),
    )
    await _validate_draft_settings(report, access, candidate)
    try:
        state = await present.save_draft(
            report, patch=patch, expected_revision=body.expected_revision
        )
    except present.DraftConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return await _draft_envelope(report, access.project, state)


@router.post("/{presentation_id}/publish")
async def publish_draft(
    presentation_id: str, body: DraftPublishBody, auth: DependencyDirectusSession
) -> dict[str, Any]:
    report, access = await _require_popcorn(presentation_id, auth)
    access.require("project:update")
    before = await service.load_settings_for(report)
    draft = await present.draft_state(report)
    _require_draft_revision(draft, body.expected_revision)
    await _validate_draft_settings(report, access, draft["settings"])
    try:
        state = await present.publish_draft(report, expected_revision=body.expected_revision)
    except present.DraftConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if state["settings"].get("public"):
        await service.ensure_public_token(report)
    try:
        await service.retarget_translation(
            report, before=before, after=state["settings"], project=access.project
        )
    except service.LoopNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    fresh = await service.async_directus.get_item("project_report", str(report["id"]))
    return await _draft_envelope(fresh or report, access.project, state)


@router.post("/{presentation_id}/opening")
async def publish_opening(
    presentation_id: str, body: OpeningPublishBody, auth: DependencyDirectusSession
) -> dict[str, Any]:
    """An edit typed on the live slide: those words go to the room and into the
    draft together, and whatever else the draft holds stays unpublished."""
    report, access = await _require_popcorn(presentation_id, auth)
    access.require("project:update")
    patch = {
        block: words for block, words in body.patch.model_dump(exclude_none=True).items() if words
    }
    if not patch:
        raise HTTPException(status_code=422, detail="The patch names no opening field.")

    async def validate(published: dict[str, Any]) -> None:
        await _validate_draft_settings(report, access, published)

    state = await present.publish_opening(report, patch=patch, validate=validate)
    return await _draft_envelope(report, access.project, state)


@router.get("/{presentation_id}/draft/audience")
async def draft_audience(
    presentation_id: str, auth: DependencyDirectusSession
) -> dict[str, Any]:
    report, access = await _require_popcorn(presentation_id, auth)
    access.require("project:update")
    state = await present.draft_state(report)
    return {
        "id": str(report["id"]),
        "manifest": present.audience_manifest(state["settings"]),
        "bundle": await bundle_for_report(
            report, access.project, host=False, settings_override=state["settings"]
        ),
    }


@router.get("/{presentation_id}/draft/map")
async def draft_map(
    presentation_id: str,
    auth: DependencyDirectusSession,
    node_limit: int | None = None,
    edge_limit: int | None = None,
) -> dict[str, Any]:
    report, access = await _require_popcorn(presentation_id, auth)
    access.require("project:update")
    settings = (await present.draft_state(report))["settings"]
    if "map" not in present.audience_manifest(settings)["blocks"]:
        raise HTTPException(status_code=404, detail="Map is not in this presentation.")
    return await present.audience_map(
        str(access.project["id"]),
        settings=settings,
        node_limit=node_limit,
        edge_limit=edge_limit,
        report=report,
    )


@router.get("/projects/{project_id}")
async def project_presentation(project_id: str, auth: DependencyDirectusSession) -> dict[str, Any]:
    access = await resolve_project_access(project_id, auth)
    access.require("project:read")
    report = await service.get_popcorn_report(project_id)
    if report and (
        not await service.get_latest_config(str(report["id"]))
        or not await service.get_loop_for_report(str(report["id"]))
    ):
        # A previous creation may have stopped after the bigint report row.
        # Keep the read endpoint mutation-free and let the authorized default
        # POST repair the deterministic config and loop rows.
        report = None
    return {
        "presentation": await present.payload(report, access.project) if report else None,
        "can_edit": access.allows("project:update"),
    }


@router.post("/projects/{project_id}/default")
async def default_presentation(project_id: str, auth: DependencyDirectusSession) -> dict[str, Any]:
    access = await resolve_project_access(project_id, auth)
    access.require("project:update")
    report = await present.ensure_default(access.project, auth.user_id)
    return await present.payload(report, access.project)


@router.post("/projects/{project_id}/start")
async def start_presentation(project_id: str, auth: DependencyDirectusSession) -> dict[str, Any]:
    access = await resolve_project_access(project_id, auth)
    access.require("project:update")
    report = await present.ensure_default(access.project, auth.user_id)
    await present.adopt_results(report, project_id, initial_only=True)
    detail = await present.payload(report, access.project)
    # Ready and valid-empty content is not regenerated when opening the screen.
    blocks = present.audience_manifest(detail["settings"])["blocks"]
    state = service.normalize_state(
        (await service.get_loop_for_report(str(report["id"])) or {}).get("popcorn_state")
    )
    bindings = (detail["settings"].get("presentation") or {}).get("result_bindings") or {}
    missing = [
        block
        for block in blocks
        if (
            block == "popcorn"
            and not detail["counts"]["phrases"]
            and not state.get("run")
            or block in ("tensions", "stakeholders")
            and not bindings.get(block)
            and not isinstance((state.get("analysis") or {}).get(block), dict)
            or block == "map"
            and not bindings.get("map")
        )
    ]
    if missing:
        readiness = await service.readiness(
            project_id=project_id, acting_directus_user_id=auth.user_id
        )
        if readiness["conversations"]:
            for block in missing:
                await _prepare_block(report, project_id, auth.user_id, block)
    return detail


@router.get("/{presentation_id}/audience")
async def audience(presentation_id: str, auth: DependencyDirectusSession) -> dict[str, Any]:
    report, access = await _require_popcorn(presentation_id, auth)
    bundle = await bundle_for_report(report, access.project, host=False)
    settings = await service.load_settings_for(report)
    return {
        "id": str(report["id"]),
        "manifest": present.audience_manifest(settings),
        "bundle": bundle,
    }


@router.get("/{presentation_id}/map")
async def presentation_map(
    presentation_id: str,
    auth: DependencyDirectusSession,
    node_limit: int | None = None,
    edge_limit: int | None = None,
) -> dict[str, Any]:
    report, access = await _require_popcorn(presentation_id, auth)
    settings = await service.load_settings_for(report)
    if "map" not in present.audience_manifest(settings)["blocks"]:
        raise HTTPException(status_code=404, detail="Map is not in this presentation.")
    return await present.audience_map(
        str(access.project["id"]),
        settings=settings,
        node_limit=node_limit,
        edge_limit=edge_limit,
        report=report,
    )


@router.get("/{presentation_id}/deck/")
async def deck(presentation_id: str, auth: DependencyDirectusSession, preview: bool = False):
    from fastapi.responses import HTMLResponse

    from dembrane.popcorn.view import render_popcorn_page

    # Embed the id the lookup returned, never the raw path value.
    report, _access = await _require_popcorn(presentation_id, auth)
    return HTMLResponse(
        render_popcorn_page(embed=_deck_embed(str(report["id"]), preview=preview)),
        headers={"Cache-Control": "no-store"},
    )


@router.get("/{presentation_id}/draft/deck/")
async def draft_deck(
    presentation_id: str, auth: DependencyDirectusSession, preview: bool = False
):
    from fastapi.responses import HTMLResponse

    from dembrane.popcorn.view import render_popcorn_page

    report, access = await _require_popcorn(presentation_id, auth)
    access.require("project:update")
    return HTMLResponse(
        render_popcorn_page(embed=_deck_embed(str(report["id"]), preview=preview)),
        headers={"Cache-Control": "no-store"},
    )


@router.get("/{presentation_id}/deck/data/bundle.json")
async def deck_bundle(presentation_id: str, auth: DependencyDirectusSession):
    from fastapi.responses import JSONResponse

    report, access = await _require_popcorn(presentation_id, auth)
    return JSONResponse(
        await bundle_for_report(report, access.project, host=False),
        headers={"Cache-Control": "no-store"},
    )


@router.get("/{presentation_id}/draft/deck/data/bundle.json")
async def draft_deck_bundle(presentation_id: str, auth: DependencyDirectusSession):
    from fastapi.responses import JSONResponse

    report, access = await _require_popcorn(presentation_id, auth)
    access.require("project:update")
    settings = (await present.draft_state(report))["settings"]
    return JSONResponse(
        await bundle_for_report(
            report, access.project, host=False, settings_override=settings
        ),
        headers={"Cache-Control": "no-store"},
    )


@router.get("/{presentation_id}/deck/events")
@router.get("/{presentation_id}/draft/deck/events")
async def deck_events(presentation_id: str, request: Request, auth: DependencyDirectusSession):
    from dembrane.api.v2.bff.popcorn import _update_stream

    report, _ = await _require_popcorn(presentation_id, auth)
    return _update_stream(request, str(report["id"]))


@router.get("/{presentation_id}/deck/logo.png")
@router.get("/{presentation_id}/draft/deck/logo.png")
async def deck_logo(presentation_id: str, auth: DependencyDirectusSession):
    from fastapi.responses import FileResponse

    from dembrane.popcorn.view import LOGO_PATH

    await _require_popcorn(presentation_id, auth)
    return FileResponse(LOGO_PATH, media_type="image/png")


@router.get("/{presentation_id}/deck/illustrations/{name}.webp")
@router.get("/{presentation_id}/draft/deck/illustrations/{name}.webp")
async def deck_illustration(presentation_id: str, name: str, auth: DependencyDirectusSession):
    from fastapi.responses import FileResponse

    from dembrane.popcorn.view import ILLUSTRATIONS

    await _require_popcorn(presentation_id, auth)
    if name not in ILLUSTRATIONS:
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(ILLUSTRATIONS[name], media_type="image/webp")


def _deck_embed(presentation_id: str, *, preview: bool = False) -> dict[str, Any]:
    from urllib.parse import urlsplit

    from dembrane.settings import get_settings

    origin = urlsplit(get_settings().urls.admin_base_url)
    return {
        "mode": "public",
        "presentationId": presentation_id,
        "parentOrigin": f"{origin.scheme}://{origin.netloc}",
        # The host's preview on the Present page, behind the session. The room's
        # public link has its own route and never says this.
        **({"preview": True} if preview else {}),
    }


@router.post("/{presentation_id}/adopt")
async def adopt(presentation_id: str, auth: DependencyDirectusSession) -> dict[str, Any]:
    report, access = await _require_popcorn(presentation_id, auth)
    access.require("project:update")
    await present.adopt_results(report, str(access.project["id"]))
    return await present.payload(report, access.project)


@router.post("/{presentation_id}/translate", status_code=202)
async def retry_translation(
    presentation_id: str, auth: DependencyDirectusSession
) -> dict[str, Any]:
    """Ask again for the texts a translation job left over. Translation only:
    no transcripts are read and no analysis runs."""
    report, access = await _require_popcorn(presentation_id, auth)
    access.require("project:update")
    loop = await service.get_loop_for_report(str(report["id"]))
    if not loop:
        raise HTTPException(status_code=404, detail="Popcorn loop not found")
    await service.dispatch_popcorn_tick_now_with_safety(str(loop["id"]), "translation")
    return await present.payload(report, access.project)


@router.get("/{presentation_id}/updates")
async def updates(presentation_id: str, auth: DependencyDirectusSession) -> dict[str, Any]:
    report, access = await _require_popcorn(presentation_id, auth)
    settings = await service.load_settings_for(report)
    manifest = settings.get("presentation") or {}
    available = await present.available_bindings(report, str(access.project["id"]))
    current = manifest.get("result_bindings") or {}
    return {
        "available": any(
            identity != current.get(block)
            for block, identity in available.items()
            if block in manifest.get("blocks", [])
        )
    }


async def _prepare_block(
    report: dict[str, Any], project_id: str, actor_id: str, block: str
) -> None:
    try:
        await _rate_limit(str(report["id"]), f"prepare:{block}")
    except HTTPException as exc:
        if exc.status_code != 429:
            raise
        return
    if block == "map":
        from dembrane.map.service import request_generation
        from dembrane.api.v2.bff.map import get_store, get_map_analysis

        await request_generation(
            project_id, actor_id, store=get_store(), analysis=get_map_analysis()
        )
    else:
        loop = await service.get_loop_for_report(str(report["id"]))
        if loop:
            await service.dispatch_popcorn_tick_now_with_safety(str(loop["id"]), f"prepare:{block}")


@router.post("/{presentation_id}/prepare/{block}")
async def prepare_block(
    presentation_id: str, block: str, auth: DependencyDirectusSession
) -> dict[str, str]:
    report, access = await _require_popcorn(presentation_id, auth)
    access.require("project:update")
    settings = await service.load_settings_for(report)
    if block not in present.audience_manifest(settings)["blocks"]:
        raise HTTPException(status_code=404, detail="Activity is not in this presentation.")
    await _prepare_block(report, str(access.project["id"]), auth.user_id, block)
    return {"status": "queued"}
