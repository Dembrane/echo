"""BFF endpoints for popcorn sessions.

Route prefix: /v2/bff/popcorn. Rides the canvas feature flag and the per-project
canvas opt-in, because popcorn runs on the same experimental loop machinery.
"""

from __future__ import annotations

import re
import json
from typing import Any, Literal
from datetime import datetime, timezone

from fastapi import Query, Depends, Request, Response, APIRouter, HTTPException, status
from pydantic import Field, BaseModel
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse

from dembrane import live_events
from dembrane.settings import get_settings
from dembrane.analytics import capture_event
from dembrane.redis_async import get_redis_client
from dembrane.popcorn.view import (
    LOGO_PATH,
    ILLUSTRATIONS,
    render_flow_page,
    render_popcorn_page,
)
from dembrane.canvas.events import generation_channel
from dembrane.directus_async import async_directus
from dembrane.popcorn.bundle import forget_bundle, bundle_for_report
from dembrane.popcorn.service import (
    LIVE_HOURS,
    REPORT_KIND,
    LoopNotFound,
    BrandingTierRequired,
    SyntheticFrameLocked,
    go_live,
    readiness,
    stop_live,
    room_files,
    list_versions,
    request_rerun,
    sample_bundle,
    create_popcorn,
    popcorn_payload,
    update_settings,
    get_version_files,
    load_settings_for,
    get_popcorn_report,
    ensure_public_token,
    get_loop_for_report,
    retarget_translation,
    expand_settings_patch,
    require_branding_tier,
    require_unlocked_frame,
    presentation_create_lock,
    dispatch_popcorn_tick_now_with_safety,
)
from dembrane.api.feature_flags import require_popcorn_enabled, require_project_popcorn_enabled
from dembrane.api.v2.bff._access import resolve_report_access, resolve_project_access
from dembrane.api.dependency_auth import DependencyDirectusSession

router = APIRouter(dependencies=[Depends(require_popcorn_enabled)])

REFRESH_TTL_SECONDS = 20
NO_STORE = {"Cache-Control": "no-store"}
# Saved runs are Directus UUIDs; anything else never reaches the page or a query.
_VERSION_ID = re.compile(r"^[0-9a-fA-F-]{36}$")


def _version_id(value: str | None) -> str | None:
    if value is None:
        return None
    if not _VERSION_ID.fullmatch(value):
        raise HTTPException(status_code=404, detail="Version not found")
    return value


class CreatePopcornBody(BaseModel):
    project_id: str
    title: str = Field(min_length=1, max_length=160)
    client: str | None = Field(default=None, max_length=160)
    voice: PopcornVoiceBody | None = None
    # Older clients still send these; a session starts in manual mode now,
    # and live has its own call.
    cadence_minutes: int | None = None
    expires_at: datetime | None = None


class PopcornVoiceBody(BaseModel):
    presets: list[str] | None = None
    note: str | None = Field(default=None, max_length=600)


class PopcornIntroBody(BaseModel):
    enabled: bool | None = None
    title: str | None = Field(default=None, max_length=160)
    subtitle: str | None = Field(default=None, max_length=600)


class PopcornDisclosureBody(BaseModel):
    enabled: bool | None = None
    text: str | None = Field(default=None, max_length=600)
    invitation_title: str | None = Field(default=None, max_length=160)
    invitation_text: str | None = Field(default=None, max_length=600)


class PopcornNoticeBody(BaseModel):
    enabled: bool | None = None
    text: str | None = Field(default=None, max_length=160)


class PopcornDataBody(BaseModel):
    enabled: bool | None = None


PopcornLanguageCode = Literal["en", "nl", "de", "fr", "es", "it", "uk", "cs"]


class PopcornLanguageBody(BaseModel):
    ui: Literal["auto"] | PopcornLanguageCode | None = None
    # "" asks for the original language again.
    translate_to: Literal[""] | PopcornLanguageCode | None = None


class PresentationBody(BaseModel):
    blocks: list[Literal["popcorn", "stakeholders", "tensions", "map"]] | None = Field(default=None, max_length=4)
    opening: Literal["popcorn", "stakeholders", "tensions", "map"] | None = None
    language_policy: Literal["project", "explicit"] | None = None
    hidden_items: list[str] | None = Field(default=None, max_length=2000)


class PopcornSettingsBody(BaseModel):
    presentation: PresentationBody | None = None
    title: str | None = Field(default=None, min_length=1, max_length=160)
    client: str | None = Field(default=None, max_length=160)
    tabs: dict[str, bool] | None = None
    public: bool | None = None
    show_qr: bool | None = None
    show_branding: bool | None = None
    public_labels: Literal["names", "neutral"] | None = None
    voice: PopcornVoiceBody | None = None
    intro: PopcornIntroBody | None = None
    disclosure: PopcornDisclosureBody | None = None
    notice: PopcornNoticeBody | None = None
    data: PopcornDataBody | None = None
    language: PopcornLanguageBody | None = None


class LiveBody(BaseModel):
    hours: int


def _as_id(value: Any) -> str | None:
    if isinstance(value, dict):
        value = value.get("id")
    return str(value) if value is not None else None


async def _rate_limit(popcorn_id: str, action: str = "refresh") -> None:
    """One press per twenty seconds per action: a second press lands on the
    tick already queued. Refresh and rerun keep separate keys, so a rerun
    right after a refresh still reruns."""
    client = await get_redis_client()
    hot = not await client.set(
        f"popcorn:{action}:{popcorn_id}", "1", ex=REFRESH_TTL_SECONDS, nx=True
    )
    if hot:
        raise HTTPException(status_code=429, detail="Just read")


async def _loop_of(report: dict[str, Any]) -> dict[str, Any]:
    loop = await get_loop_for_report(str(report["id"]))
    if not loop:
        raise HTTPException(status_code=404, detail="Popcorn loop not found")
    return loop


async def _require_popcorn(popcorn_id: str, auth: DependencyDirectusSession) -> tuple[dict, Any]:
    access, report = await resolve_report_access(popcorn_id, auth)
    require_project_popcorn_enabled(access.project)
    access.require("project:read")
    if report.get("kind") != REPORT_KIND:
        raise HTTPException(status_code=404, detail="Popcorn not found")
    return report, access


@router.get("")
async def get_project_popcorn(
    auth: DependencyDirectusSession,
    project_id: str = Query(...),
) -> dict[str, Any]:
    """The project's popcorn session, or before one exists `{"popcorn": null,
    "readiness": {...}}`: what a first read would find."""
    access = await resolve_project_access(project_id, auth)
    require_project_popcorn_enabled(access.project)
    access.require("project:read")
    report = await get_popcorn_report(project_id)
    if report:
        return {"popcorn": await popcorn_payload(report)}
    return {
        "popcorn": None,
        "readiness": await readiness(project_id=project_id, acting_directus_user_id=auth.user_id),
    }


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_project_popcorn(
    body: CreatePopcornBody,
    auth: DependencyDirectusSession,
) -> dict[str, Any]:
    access = await resolve_project_access(body.project_id, auth)
    require_project_popcorn_enabled(access.project)
    access.require("project:update")
    # The same lock the default presentation takes: a read followed by a create
    # is one session per project only while nobody else is between the two.
    async with presentation_create_lock(body.project_id):
        existing = await get_popcorn_report(body.project_id)
        if existing:
            return await popcorn_payload(existing)
        created = await create_popcorn(
            project_id=body.project_id,
            title=body.title.strip(),
            client=(body.client or "").strip() or None,
            acting_directus_user_id=auth.user_id,
        )
    if body.voice is not None:
        await update_settings(
            report=created["report"], patch={"voice": body.voice.model_dump(exclude_none=True)}
        )
    return await popcorn_payload(created["report"])


# ── try it: upstream's sample deck, no session and no model call ─────


@router.get("/sample/view/", response_class=HTMLResponse)
async def sample_view(auth: DependencyDirectusSession) -> HTMLResponse:  # noqa: ARG001
    return HTMLResponse(render_popcorn_page(embed={"mode": "sample"}), headers=NO_STORE)


@router.get("/sample/view/data/bundle.json")
async def sample_view_bundle(auth: DependencyDirectusSession) -> JSONResponse:  # noqa: ARG001
    return JSONResponse(sample_bundle(), headers={"Cache-Control": "private, max-age=60"})


@router.get("/sample/view/logo.png")
async def sample_view_logo(auth: DependencyDirectusSession) -> FileResponse:  # noqa: ARG001
    return FileResponse(LOGO_PATH, media_type="image/png")


@router.get("/sample/view/illustrations/{name}.webp")
async def sample_view_illustration(
    name: str,
    auth: DependencyDirectusSession,  # noqa: ARG001
) -> FileResponse:
    if name not in ILLUSTRATIONS:
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(ILLUSTRATIONS[name], media_type="image/webp")


@router.get("/{popcorn_id}")
async def get_popcorn(popcorn_id: str, auth: DependencyDirectusSession) -> dict[str, Any]:
    report, _access = await _require_popcorn(popcorn_id, auth)
    return await popcorn_payload(report)


@router.patch("/{popcorn_id}/settings")
async def patch_popcorn_settings(
    popcorn_id: str,
    body: PopcornSettingsBody,
    auth: DependencyDirectusSession,
) -> dict[str, Any]:
    report, access = await _require_popcorn(popcorn_id, auth)
    access.require("project:update")
    patch = body.model_dump(exclude_none=True)
    if "presentation" in patch:
        from dembrane.api.feature_flags import require_present_enabled

        require_present_enabled()
    try:
        if {"disclosure", "notice"} & patch.keys():
            await require_unlocked_frame(report, await get_loop_for_report(str(report["id"])))
        require_branding_tier(
            str(access.tier or "free"), removes_branding=patch.get("show_branding") is False
        )
    except SyntheticFrameLocked as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except BrandingTierRequired as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    if patch.get("public"):
        await ensure_public_token(report)
    before = await load_settings_for(report)
    patch = expand_settings_patch(patch, presentation_exists=bool(before.get("presentation")))
    updated = await update_settings(report=report, patch=patch)
    try:
        # A new language is translated now, not at the next scheduled read.
        await retarget_translation(report, before=before, after=updated, project=access.project)
    except LoopNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    fresh = await async_directus.get_item("project_report", str(report["id"]))
    return await popcorn_payload(fresh or report)


@router.post("/{popcorn_id}/refresh", status_code=status.HTTP_202_ACCEPTED)
async def refresh_popcorn(popcorn_id: str, auth: DependencyDirectusSession) -> dict[str, str]:
    """One read now, in any mode: changed conversations, owed second passes,
    stale analysis views."""
    report, access = await _require_popcorn(popcorn_id, auth)
    access.require("project:update")
    loop = await _loop_of(report)
    await _rate_limit(popcorn_id)
    # Handed to a worker rather than awaited: a manual pass reads every
    # conversation and the request must not hang on the slowest transcript.
    await dispatch_popcorn_tick_now_with_safety(str(loop["id"]), "manual")
    return {"tick": "queued"}


@router.post("/{popcorn_id}/rerun", status_code=status.HTTP_202_ACCEPTED)
async def rerun_popcorn(popcorn_id: str, auth: DependencyDirectusSession) -> dict[str, str]:
    """Wipe the phrases, quotes and analysis and read everything again. The
    wipe happens inside the tick, under the run lock. The saved runs stay in
    the history."""
    report, access = await _require_popcorn(popcorn_id, auth)
    access.require("project:update")
    loop = await _loop_of(report)
    await _rate_limit(popcorn_id, "rerun")
    await request_rerun(loop)
    forget_bundle(str(report["id"]))
    return {"tick": "queued"}


@router.post("/{popcorn_id}/live")
async def popcorn_live(
    popcorn_id: str, body: LiveBody, auth: DependencyDirectusSession
) -> dict[str, Any]:
    """Live for so many hours: a read every two minutes, then back to manual."""
    report, access = await _require_popcorn(popcorn_id, auth)
    access.require("project:update")
    loop = await _loop_of(report)
    try:
        await go_live(loop, hours=body.hours)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return await popcorn_payload(report)


@router.post("/{popcorn_id}/live/stop")
async def popcorn_live_stop(popcorn_id: str, auth: DependencyDirectusSession) -> dict[str, Any]:
    report, access = await _require_popcorn(popcorn_id, auth)
    access.require("project:update")
    await stop_live(await _loop_of(report))
    return await popcorn_payload(report)


# ── one release of compatibility for dashboards deployed ahead of this server ──
# The dashboard ships through Vercel and can land before the server, or after
# it. These map the old loop routes onto the modes; remove them one release
# after the dashboard has shipped without them.


class PopcornLoopSettingsBody(BaseModel):
    cadence_minutes: int | None = None
    expires_at: datetime


def _hours_until(expires_at: datetime) -> int:
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    left = (expires_at - datetime.now(timezone.utc)).total_seconds() / 3600
    return next((h for h in LIVE_HOURS if h >= left), LIVE_HOURS[-1])


@router.post("/{popcorn_id}/loop/{action}", deprecated=True)
async def popcorn_loop_action(
    popcorn_id: str, action: str, auth: DependencyDirectusSession
) -> dict[str, Any]:
    """Deprecated: go-live and resume go live for eight hours; pause and stop
    return to manual."""
    if action not in {"pause", "resume", "stop", "go-live"}:
        raise HTTPException(status_code=404, detail="Popcorn loop action not found")
    report, access = await _require_popcorn(popcorn_id, auth)
    access.require("project:update")
    loop = await _loop_of(report)
    if action in {"go-live", "resume"}:
        await go_live(loop, hours=8)
    else:
        await stop_live(loop)
    return await popcorn_payload(report)


@router.patch("/{popcorn_id}/loop", deprecated=True)
async def patch_popcorn_loop(
    popcorn_id: str, body: PopcornLoopSettingsBody, auth: DependencyDirectusSession
) -> dict[str, Any]:
    """Deprecated: live until the expiry, rounded up to the nearest duration."""
    report, access = await _require_popcorn(popcorn_id, auth)
    access.require("project:update")
    await go_live(await _loop_of(report), hours=_hours_until(body.expires_at))
    return await popcorn_payload(report)


@router.get("/{popcorn_id}/events")
async def popcorn_events(
    popcorn_id: str,
    request: Request,
    auth: DependencyDirectusSession,
) -> StreamingResponse:
    """SSE nudges whenever the tick writes new phrases or analysis, a read
    finishes, or the screen settings change. The dashboard refetches on each."""
    report, _access = await _require_popcorn(popcorn_id, auth)
    return _update_stream(request, str(report["id"]))


def _update_stream(request: Request, report_id: str) -> StreamingResponse:
    # Every nudge on the session's channel reaches the page as a bare `update`.
    return live_events.sse_response(
        request,
        [generation_channel(report_id)],
        transform=lambda _event: {"type": "update"},
    )


# ── the presentation itself, for hosts ───────────────────────────────


@router.get("/{popcorn_id}/versions")
async def popcorn_versions(
    popcorn_id: str, auth: DependencyDirectusSession
) -> list[dict[str, Any]]:
    """Saved runs, newest first. Each one replays in the deck via ?version=."""
    report, _access = await _require_popcorn(popcorn_id, auth)
    return await list_versions(str(report["id"]))


@router.get("/{popcorn_id}/view/", response_class=HTMLResponse)
async def popcorn_view(
    popcorn_id: str,
    auth: DependencyDirectusSession,
    version: str | None = Query(default=None),
) -> HTMLResponse:
    """The deck as the host sees it: the room's view plus the passage behind each
    phrase. Relative data fetches resolve under this path."""
    await _require_popcorn(popcorn_id, auth)
    # The page picks a saved run to replay from its own query string; the
    # server only checks the shape here so a bad link fails early.
    _version_id(version)
    return HTMLResponse(render_popcorn_page(embed={"mode": "host"}), headers=NO_STORE)


@router.get("/{popcorn_id}/view/events")
async def popcorn_view_events(
    popcorn_id: str, request: Request, auth: DependencyDirectusSession
) -> StreamingResponse:
    """The host deck's live data: one stream instead of polling. The deck opens
    it relative to its own address and reads its bundle on each update."""
    report, _access = await _require_popcorn(popcorn_id, auth)
    return _update_stream(request, str(report["id"]))


@router.get("/{popcorn_id}/view/flow/", response_class=HTMLResponse)
async def popcorn_view_flow(popcorn_id: str, auth: DependencyDirectusSession) -> HTMLResponse:
    """What happens to a session's words, step by step, with every check: a
    page for local development, gone wherever the API docs are off."""
    await _require_popcorn(popcorn_id, auth)
    if not get_settings().feature_flags.serve_api_docs:
        raise HTTPException(status_code=404, detail="Not found")
    return HTMLResponse(render_flow_page(), headers=NO_STORE)


@router.get("/{popcorn_id}/view/logo.png")
async def popcorn_view_logo(popcorn_id: str, auth: DependencyDirectusSession) -> FileResponse:
    await _require_popcorn(popcorn_id, auth)
    return FileResponse(
        LOGO_PATH, media_type="image/png", headers={"Cache-Control": "private, max-age=86400"}
    )


@router.get("/{popcorn_id}/view/illustrations/{name}.webp")
async def popcorn_view_illustration(
    popcorn_id: str, name: str, auth: DependencyDirectusSession
) -> FileResponse:
    if name not in ILLUSTRATIONS:
        raise HTTPException(status_code=404, detail="Not found")
    await _require_popcorn(popcorn_id, auth)
    return FileResponse(
        ILLUSTRATIONS[name],
        media_type="image/webp",
        headers={"Cache-Control": "private, max-age=86400"},
    )


@router.get("/{popcorn_id}/view/data/bundle.json")
async def popcorn_view_bundle(
    popcorn_id: str,
    auth: DependencyDirectusSession,
    version: str | None = Query(default=None),
    view: str | None = Query(default=None),
) -> JSONResponse:
    """The host's bundle, or with `view=room` exactly what the room's page
    gets: the deck asks for that while the host presents it fullscreen, so the
    wall never shows the names typed on the phones or a host-only passage."""
    report, access = await _require_popcorn(popcorn_id, auth)
    version_id = _version_id(version)
    if version_id:
        files = await get_version_files(str(report["id"]), version_id)
        if files is None:
            raise HTTPException(status_code=404, detail="Version not found")
        if view == "room":
            # The wall never sees a passage, a dashboard link or a name the
            # setting withholds, whichever bundle the run was saved as.
            settings = await load_settings_for(report)
            files = room_files(files, neutral_labels=settings.get("public_labels") != "names")
        return JSONResponse(
            {"run": None, "version": version_id, "files": files},
            headers={"Cache-Control": "private, max-age=300"},
        )
    bundle = await bundle_for_report(report, access.project, host=view != "room")
    return JSONResponse(bundle, headers=NO_STORE)


@router.post("/{popcorn_id}/view/data/latency", status_code=status.HTTP_204_NO_CONTENT)
async def popcorn_view_latency(
    popcorn_id: str, request: Request, auth: DependencyDirectusSession
) -> Response:
    """The deck's one beacon when the first phrase missed the three-second
    count. `sendBeacon` may post it as text, so the body is read by hand."""
    report, access = await _require_popcorn(popcorn_id, auth)
    try:
        ms = int((json.loads((await request.body()) or b"{}") or {}).get("ms") or 0)
    except (ValueError, TypeError):
        ms = 0
    await capture_event(
        auth.user_id,
        "popcorn_first_phrase_late",
        {
            "popcorn_id": str(report["id"]),
            "project_id": _as_id((access.project or {}).get("id")),
            "ms": max(0, min(ms, 600_000)),
        },
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
