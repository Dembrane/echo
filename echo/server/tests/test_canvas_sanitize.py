from __future__ import annotations

import pytest

from dembrane.canvas.sanitize import CanvasSanitizationError, sanitize_canvas_html


def test_sanitize_strips_external_references_and_keeps_scripts() -> None:
    result = sanitize_canvas_html(
        """```html
        <html><head><style>.x{background:url(https://example.com/a.png)}</style></head>
        <body><a href="//example.com">x</a><img src="http://example.com/a.png">
        <script>window.value = 1</script></body></html>
        ```""",
        max_bytes=2000,
    )

    assert "https://example.com" not in result.html
    assert "http://example.com" not in result.html
    assert 'href="#"' in result.html
    assert "<script>window.value = 1</script>" in result.html
    assert result.stripped_references == 3


def test_sanitize_rejects_non_document_and_oversize() -> None:
    with pytest.raises(CanvasSanitizationError, match="complete HTML"):
        sanitize_canvas_html("<div>not enough</div>", max_bytes=2000)

    with pytest.raises(CanvasSanitizationError, match="too large"):
        sanitize_canvas_html("<html><body>large</body></html>", max_bytes=5)
