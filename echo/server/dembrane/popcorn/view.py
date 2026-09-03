"""Assemble the popcorn presentation as one self-contained HTML document.

The sources under `static/` are the upstream presentation (Dembrane/popcorn
commit 7c3d1cf: index.html, assets/app.js, assets/planar.js,
assets/styles.css) with the embed patches listed in static/SOURCE.md. This
mirrors upstream `tools/build.py`: inline the stylesheet and the scripts so
the page needs nothing but its data endpoint.
"""

from __future__ import annotations

import re
import json
from typing import Any
from pathlib import Path
from functools import lru_cache

STATIC_DIR = Path(__file__).with_name("static")


def _read(name: str) -> str:
    return (STATIC_DIR / name).read_text(encoding="utf-8")


@lru_cache(maxsize=1)
def _template() -> str:
    html = _read("index.html")
    css = _read("styles.css")
    html = re.sub(
        r'<link rel="stylesheet" href="assets/styles\.css[^"]*">',
        lambda _m: "<style>\n" + css + "\n</style>",
        html,
    )

    def inline_script(match: re.Match[str]) -> str:
        src = match.group(1).split("?")[0].removeprefix("assets/")
        return "<script>\n" + _read(src) + "\n</script>"

    return re.sub(r'<script src="(assets/[^"?]+)[^"]*"></script>', inline_script, html)


def render_popcorn_page(*, embed: dict[str, Any]) -> str:
    """The page with its embed config injected ahead of the app script."""
    config = json.dumps(embed, ensure_ascii=False).replace("</", "<\\/")
    marker = "<script>\n/* popcorn"
    script = f"<script>window.POPCORN_EMBED = {config};</script>\n"
    html = _template()
    if marker in html:
        return html.replace(marker, script + marker, 1)
    return html.replace("</head>", script + "</head>", 1)


LOGO_PATH = STATIC_DIR / "dembrane-logomark-cropped.png"

NOT_LIVE_PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>popcorn</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,200..700&display=swap" rel="stylesheet">
<style>
:root{--parchment:#F6F4F1;--graphite:#2D2D2C;--blue:#4169E1;--hairline:#E6E3DF}
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%}
body{font-family:"DM Sans",system-ui,sans-serif;font-weight:300;background:var(--parchment);color:var(--graphite);display:flex;flex-direction:column;font-size:clamp(16px,1.35vw,21px);line-height:1.42}
main{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:2em}
h1{font-weight:400;font-size:2.2em;line-height:1.15;max-width:18em}
p{margin-top:1em;color:rgba(45,45,44,.62);max-width:30em}
footer{padding:.55em clamp(24px,4vw,72px);border-top:1px solid var(--hairline);font-size:.8em;text-align:right}
.wordmark{font-weight:500;color:var(--graphite)}
</style></head>
<body><main><h1>This popcorn is not live.</h1><p>The host has not published it, or the session has ended. Ask the room's host for a fresh link.</p></main>
<footer>made with <span class="wordmark">dembrane</span></footer></body></html>
"""


def render_not_live_page() -> str:
    return NOT_LIVE_PAGE
