"""Directus truncates grouped aggregate rows at its default limit (100).

Source-scan guard: every "groupBy" in dembrane/ must have "limit": -1 in the
same query. Caught live: rollup hours, BFF badges, and select-all content
checks silently wrong past 100 groups.
"""

import re
from pathlib import Path


def test_every_groupby_carries_unbounded_limit():
    root = Path(__file__).resolve().parents[1] / "dembrane"
    offenders = []
    for path in sorted(root.rglob("*.py")):
        text = path.read_text()
        for m in re.finditer(r'"groupBy"', text):
            window = text[max(0, m.start() - 600) : m.start() + 600]
            if '"limit": -1' not in window:
                line = text[: m.start()].count("\n") + 1
                offenders.append(f"{path.relative_to(root)}:{line}")
    assert not offenders, (
        "grouped aggregates missing 'limit': -1 (Directus truncates at 100 "
        f"groups): {offenders}"
    )
