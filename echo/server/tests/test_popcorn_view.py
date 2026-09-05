from __future__ import annotations

import re

from dembrane.popcorn.view import render_flow_page, render_popcorn_page


def test_page_is_self_contained_and_carries_embed_config() -> None:
    html = render_popcorn_page(embed={"mode": "public"})
    assert 'window.POPCORN_EMBED = {"mode": "public"};' in html
    # The embed config is defined before the app script reads it.
    assert html.index("window.POPCORN_EMBED") < html.index("const EMBED =")
    # Stylesheet and scripts are inlined: no relative asset requests remain.
    assert not re.search(r'href="assets/', html)
    assert not re.search(r'src="assets/', html)
    assert "<style>" in html
    assert "fetch(`data/bundle.json?t=${now}" in html
    assert ".qr-panel" in html


def test_embed_config_cannot_break_out_of_its_script_tag() -> None:
    html = render_popcorn_page(embed={"mode": "</script><script>alert(1)"})
    assert "</script><script>alert(1)" not in html
    assert "<\\/script>" in html


def test_flow_page_is_a_whole_document_with_its_diagrams() -> None:
    html = render_flow_page()
    assert html.startswith("<!doctype html>") and "<title>How popcorn works</title>" in html
    assert html.count('<pre class="mermaid">') >= 5
    assert "cdnjs.cloudflare.com/ajax/libs/mermaid/" in html
