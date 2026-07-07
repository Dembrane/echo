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


_HTML_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
_BODY_RE = re.compile(r"<body\b[^>]*>(?P<body>.*?)</body\s*>", re.IGNORECASE | re.DOTALL)
_HEAD_RE = re.compile(r"<head\b[^>]*>.*?</head\s*>", re.IGNORECASE | re.DOTALL)
_DOC_CHROME_RE = re.compile(r"<!DOCTYPE[^>]*>|</?(?:html|head|body)\b[^>]*>", re.IGNORECASE)


def extract_body_fragment(html: str) -> str:
    """Reduce model output to a body fragment.

    The client assembler owns the document (kit CSS, CSP, d3); the stored
    generation is only the content. The skill asks for a fragment, but a
    model that emits a full document anyway is unwrapped rather than
    rejected - its <head> (own styles/meta) is dropped entirely so it
    cannot fight the kit.
    """
    match = _BODY_RE.search(html)
    if match:
        return match.group("body").strip()
    without_head = _HEAD_RE.sub("", html)
    return _DOC_CHROME_RE.sub("", without_head).strip()


def sanitize_canvas_html(
    html: str,
    *,
    max_bytes: int | None = None,
) -> CanvasSanitizationResult:
    """Strip external src/href/url() references and enforce the byte cap."""
    if not isinstance(html, str) or not html.strip():
        raise CanvasSanitizationError("Empty canvas HTML")

    max_size = max_bytes or get_settings().canvas.max_html_bytes
    cleaned = extract_body_fragment(strip_markdown_fences(html))
    # HTML comments are model self-talk, not content - the skill forbids
    # them but enforcement lives here, not in the prompt.
    cleaned = _HTML_COMMENT_RE.sub("", cleaned).strip()
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

    if not cleaned or "<" not in cleaned:
        raise CanvasSanitizationError("Canvas output has no renderable content")

    size = len(cleaned.encode("utf-8"))
    if size > max_size:
        raise CanvasSanitizationError(f"Canvas HTML is too large ({size} bytes)")

    return CanvasSanitizationResult(html=cleaned, stripped_references=stripped)
