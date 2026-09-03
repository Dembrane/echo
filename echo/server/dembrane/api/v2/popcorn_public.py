"""Public, embeddable popcorn pages.

Route prefix: /v2/popcorn/public/{token}. No auth: the token is the capability,
minted per session and only honoured while the host has published the deck.
Everything else about the project stays private; the page only ever sees the
assembled bundle.
"""

from __future__ import annotations

from typing import Any

from fastapi import Depends, Request, APIRouter, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse

from dembrane.popcorn.view import LOGO_PATH, render_popcorn_page, render_not_live_page
from dembrane.api.rate_limit import create_rate_limiter
from dembrane.directus_async import async_directus
from dembrane.popcorn.bundle import load_settings, bundle_for_report
from dembrane.popcorn.service import get_report_by_public_token
from dembrane.api.feature_flags import require_canvas_enabled

router = APIRouter(dependencies=[Depends(require_canvas_enabled)])

NO_STORE = {"Cache-Control": "no-store"}
# Sized for a venue behind one NAT: the stage polls five times a second while
# empty and a few screens plus phones may all sit on the same address.
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
    report = await get_report_by_public_token(token)
    if not report:
        raise HTTPException(status_code=404, detail="Not found")
    project_id = _as_id(report.get("project_id"))
    project = await async_directus.get_item("project", project_id) if project_id else None
    if (
        not isinstance(project, dict)
        or project.get("deleted_at")
        or not project.get("is_canvas_enabled")
    ):
        raise HTTPException(status_code=404, detail="Not found")
    settings = await load_settings(report)
    if not settings.get("public"):
        raise HTTPException(status_code=404, detail="Not found")
    return report, project


@router.get("/{token}", include_in_schema=False)
async def public_popcorn_redirect(token: str) -> RedirectResponse:
    # The page fetches `data/bundle.json` relative to its own URL, so the
    # canonical address ends in a slash.
    return RedirectResponse(url=f"{token}/", status_code=307)


@router.get("/{token}/", response_class=HTMLResponse)
async def public_popcorn_page(token: str, request: Request) -> HTMLResponse:
    await _page_limiter.check(_client_ip(request))
    try:
        await _published_report(token)
    except HTTPException as exc:
        if exc.status_code != 404:
            raise
        # A person following a stale link gets a page in the deck's own voice,
        # not a JSON body.
        return HTMLResponse(render_not_live_page(), status_code=404, headers=NO_STORE)
    return HTMLResponse(render_popcorn_page(embed={"mode": "public"}), headers=NO_STORE)


@router.get("/{token}/logo.png")
async def public_popcorn_logo(token: str) -> FileResponse:  # noqa: ARG001
    # Referenced by the QR code's SVG; harmless to serve for any token.
    return FileResponse(
        LOGO_PATH, media_type="image/png", headers={"Cache-Control": "public, max-age=86400"}
    )


@router.get("/{token}/data/bundle.json")
async def public_popcorn_bundle(token: str, request: Request) -> JSONResponse:
    if not await _data_limiter.allow(_client_ip(request)):
        raise HTTPException(status_code=429, detail="Too many requests. Try again later.")
    report, project = await _published_report(token)
    return JSONResponse(await bundle_for_report(report, project), headers=NO_STORE)
