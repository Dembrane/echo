import asyncio

import pytest

from dembrane.chat_utils import generate_title

pytestmark = pytest.mark.integration


def test_generate_title():
    with asyncio.Runner() as runner:
        test_text = """Transform this content into insights that actually matter. Please:

Extract core ideas that challenge standard thinking
Write like someone who understands nuance, not a textbook
Focus on the non-obvious implications
Keep it sharp and substantive
Only highlight truly meaningful patterns
Structure for clarity and impact
Balance depth with accessibility

Note: If the similarities/differences are too superficial, let me know we need more complex material to analyze."""

        title = runner.run(generate_title(test_text, "en"))
        print(title)

        title = runner.run(generate_title(test_text, "nl"))
        print(title)

        assert title is not None
