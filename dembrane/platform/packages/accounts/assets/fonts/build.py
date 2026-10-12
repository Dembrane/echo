"""
The DM Sans cuts the PDFs draw with, made from the variable font the app ships
(frontend/src/fonts/dm-sans-variable.woff2), so a printed offer sets the same letters
as the screen: weight 320, the optical size of print, and the warm single-storey
a/g/u/y of stylistic sets ss01 to ss06 frozen into the character map (pdf-lib draws
by character, so it cannot turn a feature on).

    python3 -m pip install fonttools brotli
    python3 assets/fonts/build.py    # from packages/accounts

Re-run when the app's font file changes; the output is committed.
"""

from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parents[4] / "frontend/src/fonts/dm-sans-variable.woff2"
SETS = ["ss01", "ss02", "ss03", "ss04", "ss05", "ss06"]

# name, weight, optical size: text at 10pt, titles from 17pt up.
CUTS = [
    ("DMSans-Text", 320, 10),
    ("DMSans-Display", 320, 24),
]


def freeze(font: TTFont, tags: list[str]) -> None:
    """Points each character at the glyph the stylistic sets would substitute."""
    gsub = font["GSUB"].table
    lookups = {
        i
        for rec in gsub.FeatureList.FeatureRecord
        if rec.FeatureTag in tags
        for i in rec.Feature.LookupListIndex
    }
    swap: dict[str, str] = {}
    for i in sorted(lookups):
        lookup = gsub.LookupList.Lookup[i]
        for sub in lookup.SubTable:
            if lookup.LookupType == 7:
                sub = sub.ExtSubTable
            mapping = getattr(sub, "mapping", None)
            if mapping:
                swap.update(mapping)
    for table in font["cmap"].tables:
        for code, glyph in list(table.cmap.items()):
            if glyph in swap:
                table.cmap[code] = swap[glyph]


def name(font: TTFont, family: str) -> None:
    for rec in font["name"].names:
        if rec.nameID in (1, 4, 16):
            rec.string = family.replace("-", " ")
        elif rec.nameID == 6:
            rec.string = family


for family, weight, opsz in CUTS:
    font = TTFont(SOURCE)
    font.flavor = None
    instantiateVariableFont(font, {"wght": weight, "opsz": opsz}, inplace=True)
    freeze(font, SETS)
    name(font, family)
    font.save(HERE / f"{family}.ttf")
    print(family, (HERE / f"{family}.ttf").stat().st_size)
