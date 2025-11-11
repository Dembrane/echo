"""
Seeding helpers for bootstrap tasks that need to run during application startup.
"""

from logging import getLogger
from typing import Any, Dict, Iterable, Mapping, List

from dembrane.async_helpers import run_in_thread_pool
from dembrane.directus import directus

logger = getLogger("dembrane.seed")


DEFAULT_DIRECTUS_LANGUAGES: Iterable[Mapping[str, Any]] = [
    {"code": "en-US", "name": "English (United States)", "direction": "ltr"},
    {"code": "nl-NL", "name": "Dutch (Netherlands)", "direction": "ltr"},
    {"code": "de-DE", "name": "German (Germany)", "direction": "ltr"},
    {"code": "es-ES", "name": "Spanish (Spain)", "direction": "ltr"},
    {"code": "fr-FR", "name": "French (France)", "direction": "ltr"},
]


async def seed_default_languages() -> None:
    """
    Ensure predefined Directus languages exist.
    """
    for language in DEFAULT_DIRECTUS_LANGUAGES:
        existing = await run_in_thread_pool(
            directus.get_items,
            "languages",
            {
                "query": {
                    "filter": {"code": {"_eq": language["code"]}},
                    "fields": ["code"],
                    "limit": 1,
                }
            },
        )

        if existing:
            continue

        logger.info("Seeding language %s", language["code"])
        await run_in_thread_pool(
            directus.create_item,
            "languages",
            {
                "code": language["code"],
                "name": language["name"],
                "direction": language["direction"],
            },
        )


DEFAULT_VERIFICATION_TOPICS: List[Dict[str, Any]] = [
    {
        "key": "agreements",
        "icon": ":white_check_mark:",
        "label": "What we actually agreed on",
        "sort": 1,
        "prompt": (
            "Extract the concrete agreements and shared understandings from this conversation. "
            "Focus on points where multiple participants explicitly or implicitly aligned. "
            "Include both major decisions and small points of consensus. Present these as clear, "
            "unambiguous statements that all participants would recognize as accurate. Distinguish "
            "between firm agreements and tentative consensus. If participants used different words "
            "to express the same idea, synthesize into shared language. Format as a living document "
            "of mutual understanding. Output character should be diplomatic but precise, like meeting "
            "minutes with soul."
        ),
    },
    {
        "key": "gems",
        "icon": ":mag:",
        "label": "Hidden gems",
        "sort": 2,
        "prompt": (
            "Identify the valuable insights that emerged unexpectedly or were mentioned briefly but "
            "contain significant potential. Look for: throwaway comments that solve problems, questions "
            "that reframe the entire discussion, metaphors that clarify complex ideas, connections between "
            "seemingly unrelated points, and wisdom hiding in personal anecdotes. Present these as discoveries "
            "worth preserving, explaining why each gem matters. These are the insights people might forget but "
            "shouldn't. Output character should be excited and precise."
        ),
    },
    {
        "key": "truths",
        "icon": ":eyes:",
        "label": "Painful truths",
        "sort": 3,
        "prompt": (
            "Surface the uncomfortable realities acknowledged in this conversation - the elephants in the room that "
            "got named, the difficult facts accepted, the challenging feedback given or received. Include systemic "
            "problems identified, personal blind spots revealed, and market realities confronted. Present these with "
            "compassion but without sugar-coating. Frame them as shared recognitions that took courage to voice. "
            "These truths are painful but necessary for genuine progress. Output character should be gentle but "
            "unflinching."
        ),
    },
    {
        "key": "moments",
        "icon": ":rocket:",
        "label": "Breakthrough moments",
        "sort": 4,
        "prompt": (
            "Capture the moments when thinking shifted, new possibilities emerged, or collective understanding jumped "
            "to a new level. Identify: sudden realizations, creative solutions, perspective shifts, moments when "
            "complexity became simple, and ideas that energized the group. Show both the breakthrough itself and what "
            "made it possible. These are the moments when the conversation transcended its starting point. Output "
            "character should be energetic and forward-looking."
        ),
    },
    {
        "key": "actions",
        "icon": ":arrow_upper_right:",
        "label": "What we think should happen",
        "sort": 5,
        "prompt": (
            "Synthesize the group's emerging sense of direction and next steps. Include: explicit recommendations made, "
            "implicit preferences expressed, priorities that emerged through discussion, and logical next actions even "
            "if not explicitly stated. Distinguish between unanimous direction and majority leanings. Present as "
            "provisional navigation rather than fixed commands. This is the group's best current thinking about the "
            "path forward. Output character should be pragmatic but inspirational."
        ),
    },
    {
        "key": "disagreements",
        "icon": ":warning:",
        "label": "Moments we agreed to disagree",
        "sort": 6,
        "prompt": (
            "Document the points of productive tension where different perspectives remained distinct but respected. "
            "Include: fundamental differences in approach, varying priorities, different risk tolerances, and contrasting "
            "interpretations of data. Frame these not as failures to agree but as valuable diversity of thought. Show how "
            "each perspective has merit. These disagreements are features, not bugs - they prevent premature convergence "
            "and keep important tensions alive. Output character should be respectful and balanced."
        ),
    },
]

DEFAULT_VERIFICATION_LANG = "en-US"


async def seed_default_verification_topics() -> None:
    """
    Ensure that the canonical verification topics exist in Directus.
    """
    for topic in DEFAULT_VERIFICATION_TOPICS:
        existing = await run_in_thread_pool(
            directus.get_items,
            "verification_topic",
            {
                "query": {
                    "filter": {
                        "key": {"_eq": topic["key"]},
                        "project_id": {"_null": True},
                    },
                    "fields": ["key"],
                    "limit": 1,
                }
            },
        )

        if existing:
            continue

        logger.info("Seeding verification topic '%s'", topic["key"])
        translations_payload = [
            {
                "languages_code": DEFAULT_VERIFICATION_LANG,
                "label": topic["label"],
            }
        ]

        await run_in_thread_pool(
            directus.create_item,
            "verification_topic",
            item_data={
                "key": topic["key"],
                "prompt": topic["prompt"],
                "icon": topic["icon"],
                "sort": topic["sort"],
                "translations": {
                    "create": translations_payload,
                },
            },
        )
