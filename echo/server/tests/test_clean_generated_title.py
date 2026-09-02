from __future__ import annotations

import pytest

from dembrane.utils import clean_generated_title


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        # plain title passes through
        ("Housing Costs", "Housing Costs"),
        ("  Buurtveiligheid  \n", "Buurtveiligheid"),
        ("2025-2026 Budget", "2025-2026 Budget"),
        # lists collapse to the first option
        ("1. Housing Costs\n2. Rent Debate", "Housing Costs"),
        ("- Housing Costs\n- Rent Debate", "Housing Costs"),
        ("* Housing Costs\n* Rent Debate", "Housing Costs"),
        # preamble before a list is skipped
        (
            "Here are some options:\n1. Housing Costs\n2. Rent Debate\n3. Zoning Rules",
            "Housing Costs",
        ),
        ("Here are 3 titles:\n- **Wijkgroen**\n- Parkeerdruk", "Wijkgroen"),
        # quote and markdown wrappers stripped
        ('"Housing Costs"', "Housing Costs"),
        ("**Housing Costs**", "Housing Costs"),
        ("“Housing Costs”", "Housing Costs"),
        # a colon inside a title is kept when there is nothing after it
        ("Title: Housing Costs", "Title: Housing Costs"),
        # degenerate inputs
        ("", ""),
        ("\n\n", ""),
    ],
)
def test_clean_generated_title(raw: str, expected: str) -> None:
    assert clean_generated_title(raw) == expected
