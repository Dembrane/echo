"""Dark-theme twins of the data-policy illustrations.

Each pixel is read as a mix of ink (black), paper (white) and one of the
drawing's fills (pink, green, blue). Ink and paper trade places, the fill
stays what it is, and whatever the mix does not explain (webp noise, a fill
that is a shade off its median) is carried over untouched. Alpha is kept.

Needs numpy and pillow, which the server itself does not:
    uvx --with numpy --with pillow python scripts/popcorn_dark_illustrations.py \
        dembrane/popcorn/static/illustrations
"""

import sys
import colorsys
from pathlib import Path

import numpy as np
from PIL import Image

NAMES = ["scan", "talk-anon", "talk-public", "understand"]
INK = np.array([0, 0, 0], float) / 255
PAPER = np.array([255, 255, 255], float) / 255
# The dark screen's tokens: parchment ink for the lines, the raised "paper"
# surface for what was white, so a phone's screen still reads as a surface.
DARK_INK = np.array([0xF6, 0xF4, 0xF1], float) / 255
DARK_PAPER = np.array([0x26, 0x26, 0x25], float) / 255
HUES = {"pink": 300, "green": 148, "blue": 224}


def fills_of(rgb: np.ndarray) -> list[np.ndarray]:
    """The drawing's own fills: the median of its saturated pixels per hue."""
    flat = rgb.reshape(-1, 3)
    mx, mn = flat.max(1), flat.min(1)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
    strong = flat[(sat > 0.2) & (mx > 0.8)]
    hues = np.array([colorsys.rgb_to_hsv(*p)[0] * 360 for p in strong[::7]])
    sample = strong[::7]
    out = []
    for target in HUES.values():
        near = np.abs((hues - target + 180) % 360 - 180) < 25
        if near.sum() > 50:
            out.append(np.median(sample[near], axis=0))
    return out


def unmix(flat: np.ndarray, fill: np.ndarray):
    """Weights (ink, paper, fill) on the simplex, least squares, per pixel."""
    ends = np.stack([INK, PAPER, fill])  # 3 x 3
    best_w = np.zeros((len(flat), 3))
    best_r = np.full(len(flat), np.inf)

    def consider(w):
        r = ((flat - w @ ends) ** 2).sum(1)
        ok = (w >= -1e-9).all(1) & (r < best_r)
        best_w[ok] = w[ok]
        best_r[ok] = r[ok]

    # Inside the triangle: two free weights, the third is what is left.
    a = (ends[:2] - ends[2]).T  # 3 x 2
    sol = np.linalg.lstsq(a, (flat - ends[2]).T, rcond=None)[0].T
    consider(np.column_stack([sol, 1 - sol.sum(1)]))
    # Each edge, clamped to its segment (the corners come along for free).
    for i, j in ((0, 1), (0, 2), (1, 2)):
        d = ends[i] - ends[j]
        t = np.clip(((flat - ends[j]) @ d) / (d @ d), 0, 1)
        w = np.zeros((len(flat), 3))
        w[:, i], w[:, j] = t, 1 - t
        consider(w)
    return best_w, best_r


def smoothstep(lo: float, hi: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - lo) / (hi - lo), 0, 1)
    return t * t * (3 - 2 * t)


def calm(w: np.ndarray) -> np.ndarray:
    """Inside a fill, a trace of ink or paper is compression noise, not line.

    Swapped, a trace of paper in pink would land three times darker than it
    was light. Small traces inside a fill are handed back to the fill, so they
    ride along as the shading they were.
    """
    inside = smoothstep(0.5, 0.8, w[:, 2])
    out = w.copy()
    for i in (0, 1):
        keep = 1 - inside * (1 - smoothstep(0.06, 0.25, w[:, i]))
        out[:, i] = w[:, i] * keep
    out[:, 2] = 1 - out[:, 0] - out[:, 1]
    return out


def darken(path: Path) -> Image.Image:
    rgba = np.array(Image.open(path).convert("RGBA")).astype(float) / 255
    flat = rgba[..., :3].reshape(-1, 3)
    out = flat.copy()
    best = np.full(len(flat), np.inf)
    for fill in fills_of(rgba[..., :3][rgba[..., 3] > 0.98]):
        w, r = unmix(flat, fill)
        w = calm(w)
        better = r < best
        explained = w @ np.stack([INK, PAPER, fill])
        swapped = w @ np.stack([DARK_INK, DARK_PAPER, fill])
        out[better] = (swapped + (flat - explained))[better]
        best[better] = r[better]
    result = rgba.copy()
    result[..., :3] = np.clip(out, 0, 1).reshape(rgba[..., :3].shape)
    return Image.fromarray((result * 255).round().astype(np.uint8), "RGBA")


if __name__ == "__main__":
    folder = Path(sys.argv[1])
    for name in NAMES:
        image = darken(folder / f"{name}.webp")
        target = folder / f"{name}-dark.webp"
        image.save(target, "WEBP", quality=90, method=6, exact=False)
        print(target.name, target.stat().st_size)
