"""Brand QR code for the popcorn screen.

Mirrors the dashboard's React `QRCode` component (react-qrcode-logo with the
dembrane logomark in a circular clearing, dark modules and eyes) so a code on
the popcorn stage looks like the one hosts already print. Rendered as inline
SVG markup: the logomark is referenced by URL next to the page, which keeps the
polled bundle small and lets the browser cache the image.
"""

from __future__ import annotations

import io
import re
from functools import lru_cache

import segno

GRAPHITE = "#2D2D2C"
LOGO_FILE = "dembrane-logomark-cropped.png"
# Logo clearing as a share of the symbol width. Error level H survives 30%
# damage; the circle covers about 7% of the modules.
LOGO_SHARE = 0.24
LOGO_PADDING = 1.4


@lru_cache(maxsize=256)
def qr_svg_markup(url: str, logo_href: str = "logo.png") -> str:
    code = segno.make(url, error="h")
    buf = io.BytesIO()
    code.save(
        buf,
        kind="svg",
        xmldecl=False,
        svgns=True,
        scale=1,
        border=1,
        dark=GRAPHITE,
        light=None,
        finder_dark=GRAPHITE,
        svgclass=None,
        lineclass=None,
    )
    svg = buf.getvalue().decode("utf-8")
    width, height = code.symbol_size(scale=1, border=1)
    svg = re.sub(
        r'^<svg xmlns="http://www.w3.org/2000/svg" width="\d+" height="\d+">',
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
        f'width="100%" height="100%" role="img" shape-rendering="crispEdges">',
        svg,
        count=1,
    )
    logo = width * LOGO_SHARE
    cx = width / 2
    cy = height / 2
    overlay = (
        f'<circle cx="{cx:.2f}" cy="{cy:.2f}" r="{logo / 2 + LOGO_PADDING:.2f}" fill="#ffffff"/>'
        f'<image href="{logo_href}" x="{cx - logo / 2:.2f}" y="{cy - logo / 2:.2f}" '
        f'width="{logo:.2f}" height="{logo:.2f}" preserveAspectRatio="xMidYMid meet"/>'
    )
    return svg.replace("</svg>", overlay + "</svg>", 1)
