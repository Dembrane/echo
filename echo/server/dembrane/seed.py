"""
Seeding helpers for bootstrap tasks that need to run during application startup.
"""

import json
import asyncio
from uuid import uuid4
from typing import Any, Dict, List, Tuple, Mapping, Iterable, Optional
from logging import getLogger

from redis.asyncio import Redis

from dembrane.directus import DirectusBadRequest, directus
from dembrane.redis_async import get_redis_client
from dembrane.async_helpers import run_in_thread_pool

logger = getLogger("dembrane.seed")

DEFAULT_VERIFICATION_LANG = "en-US"
VERIFICATION_TOPIC_LOCK_KEY = "dembrane:verification_topics:reconcile_lock"
VERIFICATION_TOPIC_LOCK_TTL_SECONDS = 300


def _is_unique_constraint_error(
    exc: DirectusBadRequest,
    *,
    collection: str,
    field: str,
    value: Any,
) -> bool:
    """
    Check whether a Directus error represents a uniqueness violation for the
    provided collection/field/value combination.
    """
    try:
        payload = str(exc)
        data = json.loads(payload)
    except (json.JSONDecodeError, TypeError):
        return False

    for error in data.get("errors") or []:
        extensions = error.get("extensions") or {}
        if (
            extensions.get("collection") == collection
            and extensions.get("field") == field
            and extensions.get("code") == "RECORD_NOT_UNIQUE"
            and str(extensions.get("value")) == str(value)
        ):
            return True
    return False


async def _try_acquire_verification_topic_lock() -> Tuple[Optional[Redis], Optional[str]]:
    """
    Attempt to acquire a Redis-backed lock that serializes verification topic reconciliation.
    """
    try:
        client = await get_redis_client()
    except Exception:  # pragma: no cover - defensive logging only
        logger.warning(
            "Unable to connect to Redis for verification topic lock; continuing without lock",
            exc_info=True,
        )
        return None, None

    token = str(uuid4())
    try:
        acquired = await client.set(
            VERIFICATION_TOPIC_LOCK_KEY,
            token,
            ex=VERIFICATION_TOPIC_LOCK_TTL_SECONDS,
            nx=True,
        )
    except Exception:  # pragma: no cover - defensive logging only
        logger.warning(
            "Failed to set Redis lock for verification topic reconciliation; continuing without lock",
            exc_info=True,
        )
        return None, None

    if not acquired:
        return client, None

    return client, token


async def _release_verification_topic_lock(client: Optional[Redis], token: Optional[str]) -> None:
    """
    Release the Redis lock if we successfully acquired it.
    """
    if client is None or token is None:
        return

    release_script = """
    if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
    else
        return 0
    end
    """
    try:
        result = client.eval(
            release_script,
            1,
            VERIFICATION_TOPIC_LOCK_KEY,
            token,
        )
        # In some redis clients, eval can be sync even though client is async
        if asyncio.iscoroutine(result):
            await result
    except Exception:  # pragma: no cover - defensive logging only
        logger.warning("Failed to release Redis lock for verification topics", exc_info=True)


def _build_desired_topic_translations(topic: Mapping[str, Any]) -> Dict[str, Mapping[str, Any]]:
    """
    Normalize the desired translation payload for a verification topic.
    """
    translations = topic.get("translations") or {}
    normalized = {
        lang_code: value
        for lang_code, value in translations.items()
        if isinstance(value, Mapping) and value.get("label")
    }

    if not normalized and topic.get("label"):
        normalized = {
            DEFAULT_VERIFICATION_LANG: {"label": topic["label"]},
        }

    return normalized


async def _fetch_verification_topic_with_translations(topic_key: str) -> Optional[Dict[str, Any]]:
    """
    Retrieve a verification topic (restricted to the default/global topics) including translations.
    """
    items = await run_in_thread_pool(
        directus.get_items,
        "verification_topic",
        {
            "query": {
                "filter": {
                    "key": {"_eq": topic_key},
                    "project_id": {"_null": True},
                },
                "fields": [
                    "key",
                    "translations.id",
                    "translations.languages_code",
                    "translations.label",
                ],
                "limit": 1,
            }
        },
    )
    return items[0] if items else None


async def _fetch_single_topic_translation(
    topic_key: str, lang_code: str
) -> Optional[Dict[str, Any]]:
    """
    Fetch a single translation entry for a verification topic.
    """
    items = await run_in_thread_pool(
        directus.get_items,
        "verification_topic_translations",
        {
            "query": {
                "filter": {
                    "verification_topic_key": {"_eq": topic_key},
                    "languages_code": {"_eq": lang_code},
                },
                "fields": ["id", "languages_code", "label"],
                "limit": 1,
            }
        },
    )
    return items[0] if items else None


async def _ensure_verification_topic_translations(
    *,
    topic_key: str,
    desired_translations: Mapping[str, Mapping[str, Any]],
    existing_translations: Optional[List[Mapping[str, Any]]] = None,
) -> None:
    """
    Ensure that each desired translation exists (and matches the desired label) for a topic.
    """
    if not desired_translations:
        return

    existing_by_lang = {}
    for translation in existing_translations or []:
        lang_code = translation.get("languages_code")
        if lang_code:
            existing_by_lang[lang_code] = translation

    for lang_code, translation in desired_translations.items():
        desired_label = translation.get("label")
        if not desired_label:
            continue

        existing = existing_by_lang.get(lang_code)
        if existing is None:
            logger.info(
                "Adding translation '%s' for verification topic '%s'",
                lang_code,
                topic_key,
            )
            try:
                await run_in_thread_pool(
                    directus.create_item,
                    "verification_topic_translations",
                    {
                        "verification_topic_key": topic_key,
                        "languages_code": lang_code,
                        "label": desired_label,
                    },
                )
            except DirectusBadRequest:
                fetched = await _fetch_single_topic_translation(topic_key, lang_code)
                if fetched is None:
                    raise

                if fetched.get("label") != desired_label:
                    await run_in_thread_pool(
                        directus.update_item,
                        "verification_topic_translations",
                        fetched["id"],
                        {"label": desired_label},
                    )
            continue

        if existing.get("label") == desired_label:
            continue

        translation_id = existing.get("id")
        if translation_id is None:
            fetched = await _fetch_single_topic_translation(topic_key, lang_code)
            translation_id = fetched.get("id") if fetched else None

        if translation_id is None:
            logger.warning(
                "Unable to update translation '%s' for verification topic '%s' (missing ID)",
                lang_code,
                topic_key,
            )
            continue

        logger.info(
            "Updating translation '%s' for verification topic '%s'",
            lang_code,
            topic_key,
        )
        await run_in_thread_pool(
            directus.update_item,
            "verification_topic_translations",
            translation_id,
            {"label": desired_label},
        )


DEFAULT_DIRECTUS_LANGUAGES: Iterable[Mapping[str, Any]] = [
    {"code": "en-US", "name": "English (United States)", "direction": "ltr"},
    {"code": "nl-NL", "name": "Dutch (Netherlands)", "direction": "ltr"},
    {"code": "de-DE", "name": "German (Germany)", "direction": "ltr"},
    {"code": "es-ES", "name": "Spanish (Spain)", "direction": "ltr"},
    {"code": "fr-FR", "name": "French (France)", "direction": "ltr"},
    {"code": "it-IT", "name": "Italian (Italy)", "direction": "ltr"},
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
            logger.info("Language %s already exists; skipping", language["code"])
            continue

        logger.info("Seeding language %s", language["code"])
        try:
            await run_in_thread_pool(
                directus.create_item,
                "languages",
                {
                    "code": language["code"],
                    "name": language["name"],
                    "direction": language["direction"],
                },
            )
        except DirectusBadRequest as exc:
            if _is_unique_constraint_error(
                exc,
                collection="languages",
                field="code",
                value=language["code"],
            ):
                logger.info(
                    "Language %s already exists (likely seeded concurrently); skipping",
                    language["code"],
                )
                continue
            raise


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
        "translations": {
            "en-US": {"label": "What we actually agreed on"},
            "nl-NL": {"label": "Waar we het over eens werden"},
            "de-DE": {"label": "Worauf wir uns wirklich geeinigt haben"},
            "es-ES": {"label": "En qué estuvimos de acuerdo"},
            "fr-FR": {"label": "Ce qu'on a décidé ensemble"},
            "it-IT": {"label": "Su cosa ci siamo accordati"},
        },
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
        "translations": {
            "en-US": {"label": "Hidden gems"},
            "nl-NL": {"label": "Verborgen parels"},
            "de-DE": {"label": "Verborgene Schätze"},
            "es-ES": {"label": "Joyas ocultas"},
            "fr-FR": {"label": "Pépites cachées"},
            "it-IT": {"label": "Perle nascoste"},
        },
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
        "translations": {
            "en-US": {"label": "Painful truths"},
            "nl-NL": {"label": "Pijnlijke waarheden"},
            "de-DE": {"label": "Unbequeme Wahrheiten"},
            "es-ES": {"label": "Verdades incómodas"},
            "fr-FR": {"label": "Vérités difficiles"},
            "it-IT": {"label": "Verità scomode"},
        },
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
        "translations": {
            "en-US": {"label": "Breakthrough moments"},
            "nl-NL": {"label": "Doorbraken"},
            "de-DE": {"label": "Durchbrüche"},
            "es-ES": {"label": "Momentos decisivos"},
            "fr-FR": {"label": "Moments décisifs"},
            "it-IT": {"label": "Momenti di svolta"},
        },
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
        "translations": {
            "en-US": {"label": "What we think should happen"},
            "nl-NL": {"label": "Wat we denken dat moet gebeuren"},
            "de-DE": {"label": "Was wir denken, das passieren sollte"},
            "es-ES": {"label": "Lo que creemos que debe pasar"},
            "fr-FR": {"label": "Ce qu'on pense qu'il faut faire"},
            "it-IT": {"label": "Cosa pensiamo debba succedere"},
        },
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
        "translations": {
            "en-US": {"label": "Moments we agreed to disagree"},
            "nl-NL": {"label": "Waar we het oneens bleven"},
            "de-DE": {"label": "Worüber wir uns nicht einig wurden"},
            "es-ES": {"label": "Donde no coincidimos"},
            "fr-FR": {"label": "Là où on n'était pas d'accord"},
            "it-IT": {"label": "Dove non eravamo d'accordo"},
        },
    },
]


async def reconcile_default_verification_topics() -> None:
    """
    Reconcile the canonical verification topics and their translations in Directus.
    """
    lock_client, lock_token = await _try_acquire_verification_topic_lock()
    if lock_client is not None and lock_token is None:
        logger.info("Another worker is already reconciling verification topics; skipping this run")
        return

    try:
        for topic in DEFAULT_VERIFICATION_TOPICS:
            desired_translations = _build_desired_topic_translations(topic)
            existing_topic = await _fetch_verification_topic_with_translations(topic["key"])

            if existing_topic:
                logger.info(
                    "Verification topic '%s' already exists; reconciling translations",
                    topic["key"],
                )
                await _ensure_verification_topic_translations(
                    topic_key=topic["key"],
                    desired_translations=desired_translations,
                    existing_translations=existing_topic.get("translations") or [],
                )
                continue

            logger.info("Reconciling verification topic '%s' (creating)", topic["key"])
            translations_payload = [
                {
                    "languages_code": lang_code,
                    "label": translation["label"],
                }
                for lang_code, translation in desired_translations.items()
            ]

            if not translations_payload and topic.get("label"):
                translations_payload = [
                    {
                        "languages_code": DEFAULT_VERIFICATION_LANG,
                        "label": topic["label"],
                    }
                ]

            try:
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
            except DirectusBadRequest as exc:
                if _is_unique_constraint_error(
                    exc,
                    collection="verification_topic",
                    field="key",
                    value=topic["key"],
                ):
                    logger.info(
                        "Verification topic '%s' already exists (likely reconciled concurrently); ensuring translations",
                        topic["key"],
                    )
                    existing_topic = await _fetch_verification_topic_with_translations(topic["key"])
                    await _ensure_verification_topic_translations(
                        topic_key=topic["key"],
                        desired_translations=desired_translations,
                        existing_translations=(existing_topic or {}).get("translations") or [],
                    )
                    continue
                raise
    finally:
        await _release_verification_topic_lock(lock_client, lock_token)
