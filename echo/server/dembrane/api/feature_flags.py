"""FastAPI dependencies that gate routes behind feature flags."""

from __future__ import annotations

from fastapi import HTTPException, status

from dembrane.settings import get_settings


def require_canvas_enabled() -> None:
    """404 (not 403, to hide existence) when the canvas feature is disabled."""
    if not get_settings().feature_flags.enable_canvas:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
