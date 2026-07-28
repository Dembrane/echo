from __future__ import annotations

from typing import Any
from dataclasses import dataclass


@dataclass(frozen=True)
class OfficialMethodology:
    name: str
    description: str
    framing: str
    content: dict[str, Any]
    version_note: str
    visibility: str = "public"


DEMBRANE_METHODOLOGY = OfficialMethodology(
    name="dembrane",
    description="The default dembrane setup methodology.",
    framing=(
        "Help the host decide what this project is for, who should help define it, "
        "and whether the project should collect that input before reports or "
        "canvases are shaped."
    ),
    content={
        "opening_move": (
            "help the host define the project goal and who should be part of defining it"
        ),
        "description": (
            "Figure out what this project is for before shaping reports or canvases. "
            "Ask whether one person or a group is defining the project, and whether "
            "the project itself should collect input about its purpose before the "
            "goal is finalized."
        ),
        "setup_questions": [
            "What are you hoping to learn or decide with this project?",
            "How many people are part of defining what this project is?",
            (
                "Is the project definition already clear, or should the project "
                "collect input about what it should become?"
            ),
        ],
        "collection_guidance": (
            "If several people need to shape the project together, suggest opening "
            "that discussion and recording it with a phone or dembrane Go, with "
            "everyone's consent. Use that conversation as project material, then "
            "continue setup from what the group said."
        ),
    },
    version_note="Official dembrane methodology v2",
)

OFFICIAL_METHODOLOGIES = (DEMBRANE_METHODOLOGY,)
