"""Sanitization for generated canvas HTML.

The iframe and CSP are the primary boundary. This pass rejects network-bearing
references and enforces size so broken generations are not stored silently.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from dembrane.settings import get_settings


class CanvasSanitizationError(ValueError):
    """Raised when generated HTML cannot be safely stored."""


@dataclass(frozen=True)
class CanvasSanitizationResult:
    html: str
    stripped_references: int


_FENCE_RE = re.compile(r"^\s*```(?:html)?\s*|\s*```\s*$", re.IGNORECASE)
_ATTR_URL_RE = re.compile(
    r"""(?P<attr>\b(?:src|href)\s*=\s*)(?P<quote>["'])(?P<url>(?:https?:)?//[^"']+)(?P=quote)""",
    re.IGNORECASE,
)
_CSS_URL_RE = re.compile(
    r"""url\(\s*(?P<quote>["']?)(?P<url>(?:https?:)?//[^"')]+)(?P=quote)\s*\)""",
    re.IGNORECASE,
)


def strip_markdown_fences(text: str) -> str:
    """Remove common markdown code fences from model output."""
    return _FENCE_RE.sub("", text.strip()).strip()


def sanitize_canvas_html(
    html: str,
    *,
    max_bytes: int | None = None,
) -> CanvasSanitizationResult:
    """Strip external src/href/url() references and enforce the byte cap."""
    if not isinstance(html, str) or not html.strip():
        raise CanvasSanitizationError("Empty canvas HTML")

    max_size = max_bytes or get_settings().canvas.max_html_bytes
    cleaned = strip_markdown_fences(html)
    stripped = 0

    def _strip_attr(match: re.Match[str]) -> str:
        nonlocal stripped
        stripped += 1
        return f"{match.group('attr')}{match.group('quote')}#{match.group('quote')}"

    def _strip_css(_match: re.Match[str]) -> str:
        nonlocal stripped
        stripped += 1
        return "url('')"

    cleaned = _ATTR_URL_RE.sub(_strip_attr, cleaned)
    cleaned = _CSS_URL_RE.sub(_strip_css, cleaned)

    if not re.search(r"<\s*html\b", cleaned, re.IGNORECASE):
        raise CanvasSanitizationError("Canvas output is not a complete HTML document")

    size = len(cleaned.encode("utf-8"))
    if size > max_size:
        raise CanvasSanitizationError(f"Canvas HTML is too large ({size} bytes)")

    return CanvasSanitizationResult(html=cleaned, stripped_references=stripped)
