from __future__ import annotations

import pytest

from dembrane.canvas.sanitize import CanvasSanitizationError, sanitize_canvas_html


def test_sanitize_strips_external_references_and_keeps_scripts() -> None:
    result = sanitize_canvas_html(
        """```html
        <div class="canvas-shell" style="background:url(https://example.com/a.png)">
        <a href="//example.com">x</a><img src="http://example.com/a.png">
        <script>window.value = 1</script></div>
        ```""",
        max_bytes=2000,
    )

    assert "https://example.com" not in result.html
    assert "http://example.com" not in result.html
    assert 'href="#"' in result.html
    assert "<script>window.value = 1</script>" in result.html
    assert result.stripped_references == 3


def test_sanitize_rejects_empty_and_oversize() -> None:
    with pytest.raises(CanvasSanitizationError, match="renderable"):
        sanitize_canvas_html("just plain text with no markup", max_bytes=2000)

    with pytest.raises(CanvasSanitizationError, match="too large"):
        sanitize_canvas_html('<div class="canvas-shell">large enough</div>', max_bytes=5)


def test_sanitize_unwraps_full_documents_to_body_fragments() -> None:
    # The skill asks for a fragment; a model that emits a full document
    # anyway is unwrapped, and its own <head> (competing styles) is dropped
    # so it cannot fight the injected kit.
    result = sanitize_canvas_html(
        """<!DOCTYPE html><html lang="en"><head><title>x</title>
        <style>body{background:#fcfcfd}</style></head>
        <body><div class="canvas-shell"><p class="canvas-body">hello</p></div></body></html>""",
        max_bytes=2000,
    )

    assert "<html" not in result.html.lower()
    assert "<head" not in result.html.lower()
    assert "#fcfcfd" not in result.html
    assert '<div class="canvas-shell">' in result.html


def test_sanitize_accepts_plain_fragments() -> None:
    result = sanitize_canvas_html('<div class="canvas-shell">ok</div>', max_bytes=2000)
    assert result.html == '<div class="canvas-shell">ok</div>'


def test_sanitize_strips_html_comments() -> None:
    result = sanitize_canvas_html(
        '<div class="canvas-shell"><!-- Style overrides -->ok<!-- footer --></div>',
        max_bytes=2000,
    )
    assert "<!--" not in result.html
    assert "ok" in result.html


def test_sanitize_preserves_css_only_tabs_and_trace_expansion() -> None:
    result = sanitize_canvas_html(
        """
        <div class="canvas-shell tabbed-canvas">
          <input class="tabbed-canvas-radio" type="radio" name="canvas-tab" id="canvas-tab-crux" checked>
          <nav class="tabbed-canvas-tabbar">
            <label for="canvas-tab-crux">Crux</label>
          </nav>
          <section data-tab-panel="crux">
            <details class="tabbed-concept">
              <summary><span class="tabbed-traceable">doorway open</span></summary>
              <blockquote class="tabbed-quote">Keep the doorway open.</blockquote>
            </details>
          </section>
        </div>
        """,
        max_bytes=4000,
    )

    assert 'type="radio"' in result.html
    assert 'for="canvas-tab-crux"' in result.html
    assert "<details" in result.html
    assert "<summary>" in result.html
    assert "tabbed-traceable" in result.html


def test_sanitize_preserves_relative_chat_prefill_anchor_target() -> None:
    result = sanitize_canvas_html(
        """
        <div class="canvas-shell tabbed-canvas">
          <a class="tabbed-canvas-add"
             href="/en-US/w/workspace-1/projects/project-1/chats/new?prefill=I%20need%20a%20new%20tab%3A%20"
             target="_top">+</a>
        </div>
        """,
        max_bytes=2000,
    )

    assert "/en-US/w/workspace-1/projects/project-1/chats/new?prefill=" in result.html
    assert 'target="_top"' in result.html
    assert result.stripped_references == 0
