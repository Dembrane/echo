"""Public, embeddable popcorn pages.

Route prefix: /v2/popcorn/public/{token}. No auth: the token is the capability,
minted per session and only honoured while the host has published the deck.
Everything else about the project stays private; the page only ever sees the
assembled bundle.
"""

from __future__ import annotations

import re
import time
from typing import Any

from fastapi import Depends, Request, APIRouter, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse

from dembrane import live_events
from dembrane.popcorn.view import (
    LOGO_PATH,
    ILLUSTRATIONS,
    render_popcorn_page,
    render_not_live_page,
)
from dembrane.canvas.events import generation_channel
from dembrane.api.rate_limit import create_rate_limiter
from dembrane.directus_async import async_directus
from dembrane.popcorn.bundle import load_settings, bundle_for_report
from dembrane.popcorn.service import get_report_by_public_token
from dembrane.api.feature_flags import (
    require_popcorn_enabled,
    require_present_enabled,
    require_project_popcorn_enabled,
)

router = APIRouter(dependencies=[Depends(require_popcorn_enabled)])

NO_STORE = {"Cache-Control": "no-store"}
# Tokens are urlsafe base64 from secrets.token_urlsafe; nothing else is a token.
_TOKEN = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
# Sized for a venue behind one NAT: a few screens plus phones may all sit on
# the same address, and every one of them reads the bundle on each update.
_page_limiter = create_rate_limiter(name="popcorn_public_page", capacity=300, window_seconds=60.0)
_data_limiter = create_rate_limiter(name="popcorn_public_data", capacity=6000, window_seconds=60.0)


def _client_ip(request: Request) -> str:
    forwarded_for = request.headers.get("x-forwarded-for")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _as_id(value: Any) -> str | None:
    if isinstance(value, dict):
        value = value.get("id")
    return str(value) if value is not None else None


async def _published_report(token: str) -> tuple[dict[str, Any], dict[str, Any]]:
    if not _TOKEN.fullmatch(token):
        raise HTTPException(status_code=404, detail="Not found")
    report = await get_report_by_public_token(token)
    if not report:
        raise HTTPException(status_code=404, detail="Not found")
    project_id = _as_id(report.get("project_id"))
    project = await async_directus.get_item("project", project_id) if project_id else None
    if not isinstance(project, dict) or project.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Not found")
    require_project_popcorn_enabled(project)
    settings = await load_settings(report)
    if not settings.get("public"):
        raise HTTPException(status_code=404, detail="Not found")
    return report, project


# The page fetches `data/bundle.json` relative to its own URL, so the canonical
# address ends in a slash. The page adds the slash itself when it is missing;
# both spellings serve the same document, and nothing from the URL is echoed.
@router.get("/{token}", response_class=HTMLResponse, include_in_schema=False)
@router.get("/{token}/", response_class=HTMLResponse)
async def public_popcorn_page(token: str, request: Request) -> HTMLResponse:
    await _page_limiter.check(_client_ip(request))
    try:
        report, _project = await _published_report(token)
    except HTTPException as exc:
        if exc.status_code != 404:
            raise
        # A person following a stale link gets a page in the deck's own voice,
        # not a JSON body.
        return HTMLResponse(render_not_live_page(), status_code=404, headers=NO_STORE)
    from dembrane.api.v2.bff.present import _deck_embed

    embed = (
        _deck_embed(str(report["id"]))
        if request.query_params.get("embedded") == "1"
        else {"mode": "public"}
    )
    return HTMLResponse(render_popcorn_page(embed=embed), headers=NO_STORE)


@router.get("/{token}/logo.png")
async def public_popcorn_logo(token: str) -> FileResponse:  # noqa: ARG001
    # Referenced by the QR code's SVG; harmless to serve for any token.
    return FileResponse(
        LOGO_PATH, media_type="image/png", headers={"Cache-Control": "public, max-age=86400"}
    )


@router.get("/{token}/illustrations/{name}.webp")
async def public_popcorn_illustration(token: str, name: str) -> FileResponse:  # noqa: ARG001
    if name not in ILLUSTRATIONS:
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(
        ILLUSTRATIONS[name],
        media_type="image/webp",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@router.get("/{token}/data/bundle.json")
async def public_popcorn_bundle(token: str, request: Request) -> JSONResponse:
    if not await _data_limiter.allow(_client_ip(request)):
        raise HTTPException(status_code=429, detail="Too many requests. Try again later.")
    report, project = await _published_report(token)
    return JSONResponse(await bundle_for_report(report, project), headers=NO_STORE)


# The connect limiter bounds how fast streams open, not how many stay open.
# These bound that, per API process: the counters live in memory. A room's
# screens and phones behind one NAT share a token and an address.
_MAX_EVENT_STREAMS = 1000
_MAX_EVENT_STREAMS_PER_VIEWER = 100
# An open stream asks again at every heartbeat whether the deck is still
# published; the screens following one token share the answer for a moment.
_PUBLISHED_CHECK_SECONDS = 10.0
_published_checks: dict[str, tuple[float, bool]] = {}


async def _still_published(token: str) -> bool:
    now = time.monotonic()
    checked = _published_checks.get(token)
    if checked and now - checked[0] < _PUBLISHED_CHECK_SECONDS:
        return checked[1]
    try:
        await _published_report(token)
        published = True
    except HTTPException as exc:
        if exc.status_code != 404:
            raise
        published = False
    if len(_published_checks) > 10_000:
        _published_checks.clear()
    _published_checks[token] = (now, published)
    return published


@router.get("/{token}/events")
async def public_popcorn_events(token: str, request: Request) -> StreamingResponse:
    """The room's live data: the deck keeps this one stream open and reads its
    bundle when an update arrives. Events carry no session data at all. The
    stream ends once the host stops publishing."""
    client_ip = _client_ip(request)
    await _page_limiter.check(client_ip)
    report, _project = await _published_report(token)
    return live_events.sse_response(
        request,
        [generation_channel(str(report["id"]))],
        transform=lambda _event: {"type": "update"},
        max_streams=_MAX_EVENT_STREAMS,
        key=f"{token}:{client_ip}",
        max_streams_per_key=_MAX_EVENT_STREAMS_PER_VIEWER,
        still_allowed=lambda: _still_published(token),
    )


@router.get("/{token}/audience", dependencies=[Depends(require_present_enabled)])
async def public_presentation(token: str, request: Request) -> JSONResponse:
    from dembrane.popcorn.present import audience_manifest

    await _data_limiter.check(_client_ip(request))
    report, project = await _published_report(token)
    settings = await load_settings(report)
    return JSONResponse(
        {
            "id": str(report["id"]),
            "manifest": audience_manifest(settings),
            "bundle": await bundle_for_report(report, project, host=False),
        },
        headers=NO_STORE,
    )


@router.get("/{token}/map", dependencies=[Depends(require_present_enabled)])
async def public_presentation_map(
    token: str, request: Request, node_limit: int | None = None, edge_limit: int | None = None
) -> JSONResponse:
    from dembrane.popcorn.present import audience_map, audience_manifest

    await _data_limiter.check(_client_ip(request))
    report, project = await _published_report(token)
    settings = await load_settings(report)
    if "map" not in audience_manifest(settings)["blocks"]:
        raise HTTPException(status_code=404, detail="Map is not in this presentation.")
    return JSONResponse(
        await audience_map(
            str(project["id"]),
            settings=settings,
            node_limit=node_limit,
            edge_limit=edge_limit,
            report=report,
        ),
        headers=NO_STORE,
    )
