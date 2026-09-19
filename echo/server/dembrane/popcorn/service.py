"""Popcorn sessions: one live deck per project, riding the canvas loop machinery.

A popcorn session is a `project_report` row of kind "popcorn" with one
`canvas_config_revision` (presentation settings) and one `agent_loop` (mode,
expiry, and the extraction state). Everything the presentation reads is
assembled from that state by `build_bundle`, so the public page and the
in-app page render the same thing.

The loop's status carries the mode. `paused` is manual, the default: nothing
is scheduled, a refresh runs one tick, a rerun wipes the state and runs one.
`active` is live: the two-minute chain until `expires_at`, then back to
manual. The legacy statuses (expired, ended, stopped) read as manual. A
session never ends; the deck stays up and refresh keeps working.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
from uuid import NAMESPACE_URL, uuid5
from typing import Any
from datetime import datetime, timezone, timedelta
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator

from dembrane.utils import generate_uuid
from dembrane.policies import meets_tier
from dembrane.popcorn.qr import qr_svg_markup
from dembrane.legal_basis import DEFAULT_LEGAL_BASIS
from dembrane.redis_async import get_redis_client
from dembrane.directus_async import async_directus
from dembrane.scheduled_tasks import TASK_POPCORN_TICK, schedule_task
from dembrane.popcorn.analysis import attributes
from dembrane.popcorn.data_copy import DATA_COPY_EXTRA
from dembrane.popcorn.translate import LANGUAGES, target_languages

REPORT_KIND = "popcorn"
LOOP_KIND = "popcorn"
DEFAULT_CADENCE_MINUTES = 2
MIN_CADENCE_MINUTES = 1
MAX_CADENCE_MINUTES = 120
# How long live can be asked for, in hours.
LIVE_HOURS = (1, 8, 24)
# Extra languages a popcorn phrase may pop in, beside the one the results are
# translated into. Every phrase pops once per language, so the deck has to
# stay watchable.
MAX_ALSO_LANGUAGES = 3
STATE_VERSION = 2  # 2: one quote registry at the top of the state, validation per transcript
SETTINGS_WRITE_LOCK_TTL_SECONDS = 30
SETTINGS_WRITE_LOCK_WAIT_SECONDS = 5.0
PRESENTATION_CREATE_LOCK_TTL_SECONDS = 30
PRESENTATION_CREATE_LOCK_WAIT_SECONDS = 5.0

logger = logging.getLogger("dembrane.popcorn.service")


class LockUnavailable(RuntimeError):
    """A write could not be serialized right now: busy, or Redis is away. The
    app answers 503 and the caller tries again; nothing was written."""


class SettingsWriteLockError(LockUnavailable):
    pass


class PresentationCreateLockError(LockUnavailable):
    pass


class LoopNotFound(RuntimeError):
    """The report has no loop row, so there is nothing to dispatch a tick to."""


class BrandingTierRequired(RuntimeError):
    """The dembrane mark on the deck comes off on a paid plan only."""


class SyntheticFrameLocked(RuntimeError):
    """A synthetic demo's disclosure and notice are set with the demo."""


# Release only what this holder still owns: a lock whose TTL expired and was
# taken by someone else must survive our finally block.
_RELEASE_IF_HELD = (
    'if redis.call("get", KEYS[1]) == ARGV[1] then '
    'return redis.call("del", KEYS[1]) else return 0 end'
)


# The lease is renewed for as long as its holder is working, on the same terms.
_RENEW_IF_HELD = (
    'if redis.call("get", KEYS[1]) == ARGV[1] then '
    'return redis.call("expire", KEYS[1], ARGV[2]) else return 0 end'
)


class _LockHolder:
    """The acquired lock, with the token that proves this holder owns it."""

    def __init__(self, client: Any, key: str, token: str) -> None:
        self._client = client
        self._key = key
        self._token = token
        self._lost = False

    async def renew(self, ttl_seconds: int) -> None:
        """Keep the lease while the work runs: a read, up to three Directus
        writes and a nudge can outlast it on a slow day."""
        while not self._lost:
            await asyncio.sleep(ttl_seconds / 3)
            try:
                result = self._client.eval(
                    _RENEW_IF_HELD, 1, self._key, self._token, str(ttl_seconds)
                )
                if asyncio.iscoroutine(result):
                    result = await result
            except Exception:
                continue  # still_held() asks again before the write
            if not result:
                self._lost = True

    async def still_held(self) -> bool:
        """False once the TTL ran out and another writer took the key, so a
        long job can stop before it writes behind that writer's back."""
        if self._lost:
            return False
        try:
            current = await self._client.get(self._key)
        except Exception:
            return False
        if isinstance(current, bytes):
            current = current.decode()
        return current == self._token


@asynccontextmanager
async def _redis_lock(
    key: str,
    *,
    ttl_seconds: int,
    wait_seconds: float,
    error: type[Exception],
    busy_message: str,
    unavailable_message: str,
    log_label: str,
) -> AsyncIterator[_LockHolder]:
    """One `SET NX EX`, spun until the deadline. Redis being unreachable fails
    the write rather than letting two writers through."""
    token = secrets.token_urlsafe(24)
    try:
        client = await get_redis_client()
    except Exception as exc:
        raise error(unavailable_message) from exc
    deadline = asyncio.get_running_loop().time() + wait_seconds
    while True:
        try:
            acquired = await client.set(key, token, ex=ttl_seconds, nx=True)
        except Exception as exc:
            raise error(unavailable_message) from exc
        if acquired:
            break
        if asyncio.get_running_loop().time() >= deadline:
            raise error(busy_message)
        await asyncio.sleep(0.05)
    holder = _LockHolder(client, key, token)
    renewal = asyncio.create_task(holder.renew(ttl_seconds))
    try:
        yield holder
    finally:
        renewal.cancel()
        try:
            result = client.eval(_RELEASE_IF_HELD, 1, key, token)
            if asyncio.iscoroutine(result):
                await result
        except Exception:
            logger.warning("Failed to release the %s lock for %s", log_label, key, exc_info=True)


@asynccontextmanager
async def settings_write_lock(report_id: str) -> AsyncIterator[_LockHolder]:
    """Serialize read/merge/write of the report's shared settings JSON."""
    async with _redis_lock(
        f"popcorn:settings-write:{report_id}",
        ttl_seconds=SETTINGS_WRITE_LOCK_TTL_SECONDS,
        wait_seconds=SETTINGS_WRITE_LOCK_WAIT_SECONDS,
        error=SettingsWriteLockError,
        busy_message="Settings are busy; try again",
        unavailable_message="Settings storage is temporarily unavailable",
        log_label="settings",
    ) as holder:
        yield holder


@asynccontextmanager
async def presentation_create_lock(project_id: str) -> AsyncIterator[_LockHolder]:
    """Serialize creation of the one presentation report owned by a project."""
    async with _redis_lock(
        f"popcorn:presentation-create:{project_id}",
        ttl_seconds=PRESENTATION_CREATE_LOCK_TTL_SECONDS,
        wait_seconds=PRESENTATION_CREATE_LOCK_WAIT_SECONDS,
        error=PresentationCreateLockError,
        busy_message="Presentation creation is busy; try again",
        unavailable_message="Presentation storage is temporarily unavailable",
        log_label="presentation creation",
    ) as holder:
        yield holder


# Legacy audience tabs mirrored from the selected presentation recipes.
TOGGLEABLE_TABS = ("tensions", "stakeholders")

# Presentation recipes always follow the audience's complexity progression.
# The stored list records selection only; its incoming order is not meaningful.
PRESENTATION_BLOCKS = ("popcorn", "tensions", "map", "stakeholders")

# How the phrases should sound. The extractor prompt stays verbatim upstream;
# each chosen preset adds one host note line to the user message, and the free
# text is the host's own words. Nothing chosen means the prompt as written.
VOICE_PRESETS: dict[str, str] = {
    "gentle": (
        "Prefer the gentler of two ways the room said a thing. Leave out phrases that "
        "name, blame or single out a person."
    ),
    "plain": (
        "Prefer the plainest wording the room used. Leave out metaphors and jokes the "
        "room did not return to."
    ),
    "decisions": (
        "Favour the ideas that became a decision, a need or a next step over ideas that "
        "were only discussed."
    ),
}
VOICE_NOTE_MAX_CHARS = 600

PARTICIPANT_LANGUAGE_CODES = {
    "cs": "cs-CZ",
    "de": "de-DE",
    "en": "en-US",
    "es": "es-ES",
    "fr": "fr-FR",
    "it": "it-IT",
    "nl": "nl-NL",
    "uk": "uk-UA",
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_dt(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def loop_mode(loop: dict[str, Any] | None) -> str:
    """`live` while the two-minute chain runs; everything else is manual."""
    return "live" if (loop or {}).get("status") == "active" else "manual"


async def gather_transcripts(**kwargs: Any) -> list[dict[str, Any]]:
    """The tick's gather, reached late because the tick imports this module."""
    from dembrane.popcorn.ticks import gather_transcripts as gather

    return await gather(**kwargs)


async def cancel_pending_popcorn_ticks(loop_id: str) -> int:
    from dembrane.scheduled_tasks import cancel_pending_tasks

    return await cancel_pending_tasks(
        task_type=TASK_POPCORN_TICK, payload_match={"loop_id": loop_id}
    )


def _data(result: dict[str, Any]) -> dict[str, Any]:
    return result["data"] if isinstance(result, dict) and "data" in result else result


def _as_id(value: Any) -> str | None:
    if isinstance(value, dict):
        value = value.get("id")
    return str(value) if value is not None else None


def is_popcorn_loop(loop: dict[str, Any] | None) -> bool:
    caps = (loop or {}).get("caps")
    return isinstance(caps, dict) and caps.get("kind") == LOOP_KIND


# The screens before the countdown and the bar above every tab, each a switch
# plus the host's words with their length limits. Any session may use them.
OPENING_BLOCKS: dict[str, dict[str, int]] = {
    "intro": {"title": 160, "subtitle": 600},
    "disclosure": {"text": 600, "invitation_title": 160, "invitation_text": 600},
    "notice": {"text": 160},
    # The data screen has no words of its own: they follow the project.
    "data": {},
}

# The data screen, step by step. Its words follow the project's
# anonymisation and effective legal basis, never the host's typing, so the
# screen cannot promise more than the platform does. They say what happens to
# the data and nothing about the shape of the event, so a host can show this
# screen whatever the format is.
DATA_COPY: dict[str, dict[str, Any]] = {
    "nl": {
        "title": "Dit gebeurt er stap voor stap met je gegevens",
        "scan": "Je scant de QR-code. Die telefoon maakt verbinding met dembrane.",
        "talk-anon": (
            "Het geluid wordt uitgeschreven. We halen namen die naar jou kunnen leiden uit het "
            "transcript, en de organisator kan de opname niet beluisteren. Geen training, geen gedoe."
        ),
        "talk-public": (
            "Het geluid wordt uitgeschreven en geanalyseerd. De organisator kan het gebruiken "
            "voor onderzoek."
        ),
        "understand": (
            "Daarna analyseert dembrane alle gesprekken om te zien wat de groep echt "
            "belangrijk vindt."
        ),
        "legal": {
            "consent": (
                "Voor je begint, vragen we je toestemming. De privacyverklaring van de "
                "organisator is van toepassing."
            ),
            "client-managed": "De organisator bepaalt wat er met de gesprekken gebeurt.",
            "dembrane-events": (
                "dembrane organiseert deze sessie en verwerkt de gesprekken op basis van "
                "gerechtvaardigd belang."
            ),
        },
        "hood": (
            "Onder de motorkap gebeurt de verwerking op servers van Google Vertex AI in de EU. "
            "Opgeslagen gegevens staan versleuteld op servers in Amsterdam."
        ),
        "policy": "Privacyverklaring van de organisator",
        "trust": {"url": "https://dembrane.com/nl/trust", "label": "Meer op dembrane.com/nl/trust"},
    },
    "en": {
        "title": "Here's what happens to your data, step by step",
        "scan": "You scan the QR code, and that phone connects with dembrane.",
        "talk-anon": (
            "The audio is transcribed. We scrub the transcript of any names that could lead back "
            "to you, and your host cannot listen to the recording. No training, no nonsense."
        ),
        "talk-public": "The audio is transcribed and analysed. The host may use it for research.",
        "understand": (
            "Then dembrane analyses all the conversations to identify what the group "
            "really cares about."
        ),
        "legal": {
            "consent": (
                "You are asked for your consent before you start. The organiser's privacy "
                "policy applies."
            ),
            "client-managed": "The organiser decides what happens with the conversations.",
            "dembrane-events": (
                "dembrane organises this session and processes the conversations on the basis "
                "of legitimate interest."
            ),
        },
        "hood": (
            "Under the hood, processing happens on Google Vertex AI servers in the EU. "
            "Stored data is encrypted on servers in Amsterdam."
        ),
        "policy": "The organiser's privacy policy",
        "trust": {"url": "https://dembrane.com/trust", "label": "Details at dembrane.com/trust"},
    },
}

DATA_COPY.update(DATA_COPY_EXTRA)

# What a synthetic demo says where its host left the words empty.
SYNTHETIC_COPY: dict[str, dict[str, str]] = {
    "nl": {
        "disclosure": (
            "Alle uitspraken, spanningen en perspectieven in dit voorbeeld zijn verzonnen "
            "voor demonstratiedoeleinden. Het is geen verslag van een echte bijeenkomst en "
            "geeft niet weer wat mensen werkelijk vinden."
        ),
        "invitation_title": "Het begint met écht luisteren",
        "invitation_text": (
            "De echte verhalen komen van de mensen om wie het gaat.\n\n"
            "Hun ervaringen, vragen en verschillen geven een bijeenkomst betekenis en "
            "vullen dit scherm met echte verhalen en perspectieven."
        ),
        "notice": "Synthetische demo · verzonnen perspectieven, geen echte gespreksuitkomsten.",
    },
    "en": {
        "disclosure": (
            "Every contribution, tension and perspective in this example is fictional and "
            "created for demonstration. These are not real people's perspectives or "
            "findings from an event."
        ),
        "invitation_title": "It starts with listening to real people",
        "invitation_text": (
            "The real stories come from the people it is about.\n\n"
            "Their experiences, questions and differences give a gathering its meaning and "
            "fill this screen with real stories and perspectives."
        ),
        "notice": "Synthetic demo · fictional perspectives, not real conversation findings.",
    },
}


def normalize_block(raw: Any, limits: dict[str, int]) -> dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    block: dict[str, Any] = {"enabled": bool(raw.get("enabled", False))}
    for key, limit in limits.items():
        block[key] = str(raw.get(key) or "").strip()[:limit]
    return block


def normalize_language(raw: Any) -> dict[str, Any]:
    """The screen's own language (`auto` follows the project), the language the
    results are translated into when the host asked for one, and the extra
    languages the popcorn phrases pop in after it.

    The extra languages only have an effect beside a language for the results:
    `target_languages` is what reads them, and it answers nothing without one.
    """
    raw = raw if isinstance(raw, dict) else {}
    ui = str(raw.get("ui") or "auto")
    target = str(raw.get("translate_to") or "")
    target = target if target in LANGUAGES else ""
    also = raw.get("also")
    return {
        "ui": ui if ui in LANGUAGES else "auto",
        "translate_to": target,
        "also": [
            code
            for code in dict.fromkeys(also if isinstance(also, list) else [])
            if code in LANGUAGES and code != target
        ][:MAX_ALSO_LANGUAGES],
    }


def screen_language(settings: dict[str, Any], demo: dict[str, Any], project: dict[str, Any]) -> str:
    """The language of the screen's own words. Automatic follows the
    results: their translation when the host asked for one, else the
    project's language (a demo's own)."""
    language = normalize_language(settings.get("language"))
    choice = language["ui"]
    if choice == "auto":
        spoken = demo.get("language") if demo.get("synthetic") else project.get("language")
        choice = language["translate_to"] or str(spoken or "en").split("-")[0]
    return choice if choice in LANGUAGES else "en"


def default_settings(*, title: str, client: str | None = None) -> dict[str, Any]:
    return {
        "title": title,
        "client": client or "",
        "tabs": {tab: True for tab in TOGGLEABLE_TABS},
        "public": False,
        "show_qr": False,
        "show_branding": True,
        "voice": {"presets": [], "note": ""},
        "public_labels": "neutral",
        **{name: normalize_block(None, limits) for name, limits in OPENING_BLOCKS.items()},
        "language": normalize_language(None),
    }


def normalize_presentation(raw: Any) -> dict[str, Any] | None:
    """The stored manifest as the room must read it.

    Popcorn is where the screen absorbs latency: it has content while every
    other block is still being made. So a presentation always carries it and
    always opens on it. Settings saved before that rule, and a patch that asks
    for another opening or drops Popcorn, are normalised rather than refused.
    """
    if not isinstance(raw, dict):
        return None
    raw_blocks = raw.get("blocks")
    raw_blocks = raw_blocks if isinstance(raw_blocks, list) else ["popcorn"]
    selected = {b for b in raw_blocks if isinstance(b, str) and b in PRESENTATION_BLOCKS}
    selected.add("popcorn")
    blocks = [block for block in PRESENTATION_BLOCKS if block in selected]
    hidden = raw.get("hidden_items")
    hidden = hidden if isinstance(hidden, list) else []
    bindings = raw.get("result_bindings")
    bindings = bindings if isinstance(bindings, dict) else {}
    return {
        "version": 1,
        "blocks": blocks,
        "opening": "popcorn",
        "language_policy": "project" if raw.get("language_policy") == "project" else "explicit",
        "hidden_items": list(dict.fromkeys(str(x) for x in hidden if isinstance(x, str)))[:2000],
        "result_bindings": {
            str(k): str(v)
            for k, v in bindings.items()
            if k in PRESENTATION_BLOCKS and isinstance(v, str)
        },
    }


def resolve_project_language(value: Any) -> tuple[str, str | None]:
    code = str(value or "").strip().lower().replace("_", "-").split("-")[0]
    if code in LANGUAGES:
        return code, None
    return "en", "multilingual" if code == "multi" else "not_set"


def resolve_presentation_settings(
    settings: dict[str, Any], project: dict[str, Any]
) -> dict[str, Any]:
    """Resolve the saved policy without modifying it or starting processing."""
    presentation = settings.get("presentation")
    if not presentation or presentation.get("language_policy") != "project":
        return settings
    language, _reason = resolve_project_language(project.get("language"))
    # The policy owns the language of the results, not the extra popcorn
    # languages: those are the host's own choice and pass through.
    also = normalize_language(settings.get("language"))["also"]
    return {
        **settings,
        "language": {"ui": language, "translate_to": language, "also": also},
    }


def normalize_voice(raw: Any) -> dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    chosen = raw.get("presets")
    if not isinstance(chosen, list):
        single = raw.get("preset")
        chosen = [single] if isinstance(single, str) else []
    presets = [key for key in VOICE_PRESETS if key in chosen]
    note = " ".join(str(raw.get("note") or "").split())[:VOICE_NOTE_MAX_CHARS]
    return {"presets": presets, "note": note}


def voice_host_note(voice: dict[str, Any] | None) -> str:
    """The text appended to the extractor's user message, or empty for the default voice."""
    voice = normalize_voice(voice)
    parts = [VOICE_PRESETS[key] for key in voice["presets"]] + [voice["note"]]
    return "\n".join(part for part in parts if part).strip()


def normalize_settings(raw: dict[str, Any] | None, *, fallback_title: str) -> dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    recipe_settings = raw.get("recipe_settings")
    recipe_settings = recipe_settings if isinstance(recipe_settings, dict) else {}
    tabs_value = raw.get("tabs")
    tabs_raw: dict[str, Any] = tabs_value if isinstance(tabs_value, dict) else {}
    return {
        **(
            {"presentation": normalize_presentation(raw["presentation"])}
            if isinstance(raw.get("presentation"), dict)
            else {}
        ),
        "title": str(raw.get("title") or fallback_title).strip()[:160] or fallback_title,
        "client": str(raw.get("client") or "").strip()[:160],
        "tabs": {tab: bool(tabs_raw.get(tab, True)) for tab in TOGGLEABLE_TABS},
        "public": bool(raw.get("public", False)),
        "show_qr": bool(raw.get("show_qr", False)),
        # "made with dembrane" on the deck. Off is a Changemaker feature, like
        # whitelabel; the API enforces the tier, the setting only records it.
        "show_branding": bool(raw.get("show_branding", True)),
        "voice": normalize_voice(recipe_settings.get("voice", raw.get("voice"))),
        "recipe_settings": {
            "voice": normalize_voice(recipe_settings.get("voice", raw.get("voice")))
        },
        **{name: normalize_block(raw.get(name), limits) for name, limits in OPENING_BLOCKS.items()},
        "language": normalize_language(raw.get("language")),
        # What the room's legend calls a conversation. A conversation's label is
        # the name typed on the phone, which may be a person's; the public page
        # numbers them unless the host chooses otherwise. The host page always
        # shows the names.
        "public_labels": "names" if raw.get("public_labels") == "names" else "neutral",
    }


def fresh_state() -> dict[str, Any]:
    return {
        "version": STATE_VERSION,
        "run": 0,
        "order": [],
        "conversations": {},
        "quotes": [],
        "analysis": None,
    }


def normalize_state(raw: Any) -> dict[str, Any]:
    state = fresh_state()
    if not isinstance(raw, dict):
        return state
    state["run"] = int(raw.get("run") or 0)
    # Provenance belongs to the data, never to a hideable screen setting.
    if isinstance(raw.get("demo"), dict) and raw["demo"].get("synthetic") is True:
        demo = dict(raw["demo"])
        for key in ("disclosure", "notice", "portal_urls"):
            if not isinstance(demo.get(key), dict):
                demo.pop(key, None)
        state["demo"] = demo
    conversations_value = raw.get("conversations")
    conversations: dict[Any, Any] = (
        conversations_value if isinstance(conversations_value, dict) else {}
    )
    state["conversations"] = {str(k): v for k, v in conversations.items() if isinstance(v, dict)}
    order_raw = raw.get("order")
    order: list[Any] = order_raw if isinstance(order_raw, list) else []
    state["order"] = [str(cid) for cid in order if str(cid) in state["conversations"]]
    for cid in state["conversations"]:
        if cid not in state["order"]:
            state["order"].append(cid)
    analysis = dict(raw["analysis"]) if isinstance(raw.get("analysis"), dict) else None
    quotes_raw = raw.get("quotes")
    if not isinstance(quotes_raw, list) and analysis is not None:
        # Version 1 kept the registry inside the analysis block; it is the session's now.
        quotes_raw = analysis.pop("quotes", None)
    elif analysis is not None:
        analysis.pop("quotes", None)
    state["quotes"] = [q for q in (quotes_raw or []) if isinstance(q, dict) and q.get("id")]
    state["analysis"] = analysis
    # Translations the host asked for, per language, keyed by source text.
    translations = raw.get("translations")
    if isinstance(translations, dict):
        state["translations"] = {
            str(lang): {str(k): str(v) for k, v in table.items() if isinstance(v, str)}
            for lang, table in translations.items()
            if lang in LANGUAGES and isinstance(table, dict)
        }
    return state


def participant_url(project: dict[str, Any], participant_base_url: str) -> str | None:
    """The portal start link, tagged so PostHog can tell a popcorn scan apart."""
    project_id = _as_id(project.get("id"))
    if not project_id or not project.get("is_conversation_allowed"):
        return None
    language = str(project.get("language") or "en")
    code = PARTICIPANT_LANGUAGE_CODES.get(language.split("-")[0], "en-US")
    return f"{participant_base_url.rstrip('/')}/{code}/{project_id}/start?utm_source=popcorn_qr"


# ── persistence ──────────────────────────────────────────────────────


async def get_popcorn_report(project_id: str) -> dict[str, Any] | None:
    rows = await async_directus.get_items(
        "project_report",
        {
            "query": {
                "filter": {
                    "project_id": {"_eq": project_id},
                    "kind": {"_eq": REPORT_KIND},
                    "deleted_at": {"_null": True},
                },
                "sort": ["-date_created"],
                "limit": 1,
            }
        },
    )
    return rows[0] if isinstance(rows, list) and rows else None


async def get_loop_for_report(report_id: str) -> dict[str, Any] | None:
    rows = await async_directus.get_items(
        "agent_loop",
        {
            "query": {
                "filter": {"report_id": {"_eq": report_id}},
                "sort": ["-created_at"],
                "limit": 1,
            }
        },
    )
    return rows[0] if isinstance(rows, list) and rows else None


async def get_latest_config(report_id: str) -> dict[str, Any] | None:
    rows = await async_directus.get_items(
        "canvas_config_revision",
        {
            "query": {
                "filter": {"report_id": {"_eq": report_id}},
                "sort": ["-created_at"],
                "limit": 1,
            }
        },
    )
    return rows[0] if isinstance(rows, list) and rows else None


async def get_latest_run(loop_id: str) -> dict[str, Any] | None:
    rows = await async_directus.get_items(
        "agent_loop_run",
        {
            "query": {
                "filter": {"loop_id": {"_eq": loop_id}},
                "sort": ["-started_at"],
                "limit": 1,
            }
        },
    )
    return rows[0] if isinstance(rows, list) and rows else None


async def enqueue_popcorn_tick(
    loop_id: str,
    when: datetime | None = None,
    tick_kind: str = "scheduled",
    request_id: str | None = None,
) -> str:
    payload = {"loop_id": loop_id, "tick_kind": tick_kind}
    if request_id:
        payload["request_id"] = request_id
    return await schedule_task(
        task_type=TASK_POPCORN_TICK,
        scheduled_at=when or _now(),
        payload=payload,
    )


def dispatch_popcorn_tick_now(
    loop_id: str, tick_kind: str = "manual", request_id: str | None = None
) -> None:
    """Hand a tick to a worker immediately instead of waiting for the scheduler poll."""
    from dembrane.tasks import task_popcorn_tick_now

    task_popcorn_tick_now.send(loop_id, tick_kind, request_id=request_id)


SAFETY_TICK_DELAY_SECONDS = 0


async def dispatch_popcorn_tick_now_with_safety(loop_id: str, tick_kind: str = "manual") -> None:
    """Persist the backup before dispatch, with one identity for both deliveries.
    Under the run lock, a completed run with this id makes a late backup a
    no-op, even if the scheduler already claimed it before cancellation."""
    request_id = generate_uuid()
    await enqueue_popcorn_tick(
        loop_id,
        when=_now() + timedelta(seconds=SAFETY_TICK_DELAY_SECONDS),
        tick_kind=tick_kind,
        request_id=request_id,
    )
    dispatch_popcorn_tick_now(loop_id, tick_kind, request_id=request_id)


async def create_popcorn(
    *,
    project_id: str,
    title: str,
    client: str | None,
    acting_directus_user_id: str,
    start_processing: bool = True,
    initial_settings: dict[str, Any] | None = None,
    report: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Create the report row, its settings revision, the loop in manual mode,
    and optionally one read. Nothing repeats until the host goes live."""
    cadence = DEFAULT_CADENCE_MINUTES
    repairing = report is not None
    if report is None:
        report = _data(
            await async_directus.create_item(
                "project_report",
                {
                    "project_id": project_id,
                    "kind": REPORT_KIND,
                    "status": "published",
                    "user_instructions": title,
                    "content": "",
                    "public_token": secrets.token_urlsafe(24),
                    "user_created": acting_directus_user_id,
                },
            )
        )
    report_id = str(report["id"])
    config = await get_latest_config(report_id) if repairing else None
    if config is None:
        config = _data(
            await _create_once(
                "canvas_config_revision",
                {
                    "id": str(uuid5(NAMESPACE_URL, f"popcorn:report:{report_id}:config")),
                    "report_id": report_id,
                    "brief": "",
                    "gather_spec": {"full_history": True},
                    "popcorn_settings": initial_settings
                    or default_settings(title=title, client=client),
                    "cadence_minutes": cadence,
                    "created_by": acting_directus_user_id,
                    "note": "initial",
                },
            )
        )
    loop = await get_loop_for_report(report_id) if repairing else None
    if loop is None:
        loop = _data(
            await _create_once(
                "agent_loop",
                {
                    "id": str(uuid5(NAMESPACE_URL, f"popcorn:report:{report_id}:loop")),
                    "project_id": project_id,
                    "report_id": report_id,
                    "name": title,
                    "status": "paused",
                    "expires_at": _now().isoformat(),
                    "cadence_minutes": cadence,
                    "acting_directus_user_id": acting_directus_user_id,
                    "failure_count": 0,
                    "caps": {"kind": LOOP_KIND},
                    "popcorn_state": fresh_state(),
                },
            )
        )
    if start_processing:
        await dispatch_popcorn_tick_now_with_safety(str(loop["id"]), "manual")
    return {"report": report, "config": config, "loop": loop}


async def _create_once(collection: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Deterministic primary keys make concurrent default creation converge.

    Re-reading after a conflict also repairs partial creation on a retry. An
    unavailable database is never mistaken for a successful creation.
    """
    identity = payload.get("id")
    if identity:
        existing = await async_directus.get_item(collection, str(identity))
        if existing:
            return existing
    try:
        return _data(await async_directus.create_item(collection, payload))
    except Exception:
        if identity:
            existing = await async_directus.get_item(collection, str(identity))
            if existing:
                return existing
        raise


# ── versions ─────────────────────────────────────────────────────────


async def save_version(
    *,
    report_id: str,
    config_id: str | None,
    files: dict[str, Any],
    tick_kind: str,
    detail: str,
) -> dict[str, Any]:
    """Snapshot the host bundle after a tick that changed something, so a run can
    be replayed later. Stored in the canvas generation table as JSON text."""
    import json

    return _data(
        await async_directus.create_item(
            "canvas_generation",
            {
                "id": generate_uuid(),
                "report_id": report_id,
                "config_revision_id": config_id,
                "content_html": json.dumps({"files": files}, ensure_ascii=False),
                "status": "ok",
                "tick_kind": tick_kind,
                "detail": detail[:5000],
            },
        )
    )


async def list_versions(report_id: str, limit: int = 30) -> list[dict[str, Any]]:
    rows = await async_directus.get_items(
        "canvas_generation",
        {
            "query": {
                "filter": {"report_id": {"_eq": report_id}, "status": {"_eq": "ok"}},
                "fields": ["id", "created_at", "detail", "tick_kind"],
                "sort": ["-created_at"],
                "limit": limit,
            }
        },
    )
    return [
        {
            "id": str(row["id"]),
            "created_at": row.get("created_at"),
            "tick_kind": row.get("tick_kind"),
            "detail": row.get("detail"),
        }
        for row in (rows if isinstance(rows, list) else [])
    ]


async def get_version_files(report_id: str, version_id: str) -> dict[str, Any] | None:
    import json

    row = await async_directus.get_item("canvas_generation", version_id)
    if not isinstance(row, dict) or _as_id(row.get("report_id")) != report_id:
        return None
    try:
        parsed = json.loads(str(row.get("content_html") or ""))
    except ValueError:
        return None
    files = parsed.get("files") if isinstance(parsed, dict) else None
    return files if isinstance(files, dict) else None


# The two screens a synthetic demo writes for itself.
FRAME_BLOCKS = ("disclosure", "notice")


def expand_settings_patch(
    patch: dict[str, Any], *, presentation_exists: bool = True
) -> dict[str, Any]:
    """The legacy audience tabs follow the chosen blocks, and a language picked
    by hand stops a presentation following the project's.

    A session without a presentation manifest has no policy to make explicit,
    so `presentation_exists=False` leaves the language alone.
    """
    patch = dict(patch)
    if "presentation" in patch:
        blocks = patch["presentation"].get("blocks")
        if blocks is not None:
            patch["tabs"] = {kind: kind in blocks for kind in TOGGLEABLE_TABS}
    if "language" in patch and "presentation" not in patch and presentation_exists:
        patch["presentation"] = {"language_policy": "explicit"}
    return patch


def require_branding_tier(tier: str, *, removes_branding: bool) -> None:
    """The setting only records the choice; the tier is enforced here."""
    if removes_branding and not meets_tier(tier, "changemaker"):
        raise BrandingTierRequired("Removing the dembrane mark requires the changemaker tier.")


async def require_unlocked_frame(
    report: dict[str, Any],
    loop: dict[str, Any] | None,
    *,
    proposed: dict[str, Any] | None = None,
) -> None:
    """A synthetic demo's disclosure and notice belong to the demo, not the host.

    With `proposed` settings the published wording is compared, so a write that
    leaves the frame as it is passes; without them any write to it is refused.
    The caller reads the loop, because it usually has one already.
    """
    if not is_synthetic_session(normalize_state((loop or {}).get("popcorn_state"))):
        return
    if proposed is not None:
        published = await load_settings_for(report)
        if all(proposed[name] == published[name] for name in FRAME_BLOCKS):
            return
    raise SyntheticFrameLocked("A synthetic demo's disclosure and frame are set with the demo.")


def merge_settings(
    current: dict[str, Any], patch: dict[str, Any], *, fallback_title: str
) -> dict[str, Any]:
    """Apply the shared partial-settings semantics and normalize the result."""
    merged = dict(current)
    for key in ("title", "client", "public", "show_qr", "show_branding", "public_labels"):
        if key in patch and patch[key] is not None:
            merged[key] = patch[key]
    for key in ("voice", "language", *OPENING_BLOCKS):
        if isinstance(patch.get(key), dict):
            merged[key] = {**current[key], **patch[key]}
    if isinstance(patch.get("voice"), dict):
        merged["recipe_settings"] = {"voice": merged["voice"]}
    if isinstance(patch.get("presentation"), dict):
        manifest = current.get("presentation") or {}
        merged["presentation"] = {**manifest, **patch["presentation"]}
        # A bindings patch names the blocks it adopts and leaves the rest: two
        # adopters who each found one result must not drop the other's.
        if isinstance(patch["presentation"].get("result_bindings"), dict):
            merged["presentation"]["result_bindings"] = {
                **(manifest.get("result_bindings") or {}),
                **patch["presentation"]["result_bindings"],
            }
    if isinstance(patch.get("tabs"), dict):
        merged["tabs"] = {
            **current["tabs"],
            **{k: bool(v) for k, v in patch["tabs"].items() if k in TOGGLEABLE_TABS},
        }
    return normalize_settings(merged, fallback_title=fallback_title)


async def update_settings(
    *,
    report: dict[str, Any],
    patch: dict[str, Any],
) -> dict[str, Any]:
    """Update presentation settings in place. They are toggles, not analysis config,
    so they do not earn a new revision the way a canvas brief does."""
    async with settings_write_lock(str(report["id"])) as holder:
        return await _update_settings_unlocked(report=report, patch=patch, holder=holder)


async def _update_settings_unlocked(
    *, report: dict[str, Any], patch: dict[str, Any], holder: _LockHolder
) -> dict[str, Any]:
    report_id = str(report["id"])
    config = await get_latest_config(report_id)
    if not config:
        raise RuntimeError("Popcorn settings revision not found")
    fallback_title = str(report.get("user_instructions") or "Popcorn")
    raw_settings = config.get("popcorn_settings")
    raw_settings = raw_settings if isinstance(raw_settings, dict) else {}
    current = normalize_settings(raw_settings, fallback_title=fallback_title)
    settings = merge_settings(current, patch, fallback_title=fallback_title)
    # Present keeps its unpublished editor state beside the published settings.
    # Legacy settings mutations must never discard that reserved host-only value.
    if isinstance(raw_settings.get("_present_draft"), dict):
        settings["_present_draft"] = raw_settings["_present_draft"]
    await write_settings(
        report, config, settings, fallback_title=fallback_title, nudge=True, holder=holder
    )
    # Keep the reserved draft container out of every settings response.
    return normalize_settings(settings, fallback_title=fallback_title)


async def write_config_settings(
    config: dict[str, Any], settings: dict[str, Any], *, holder: _LockHolder
) -> None:
    """The one write of the settings JSON, draft container and all. Directus
    has no conditional update, so ownership of the lock is asked one last time
    here: a writer that stalled past its lease stops instead of overwriting."""
    if not await holder.still_held():
        raise SettingsWriteLockError("Settings are busy; try again")
    await async_directus.update_item(
        "canvas_config_revision", str(config["id"]), {"popcorn_settings": settings}
    )


async def _invalidate_and_nudge(report_id: str) -> None:
    """The cached bundle goes first, the nudge second: a screen that refetches
    on the nudge must not be answered from the deck the write just replaced."""
    from dembrane.canvas.events import publish_generation_nudge
    from dembrane.popcorn.bundle import forget_bundle

    forget_bundle(report_id)
    await publish_generation_nudge(report_id)


async def write_settings(
    report: dict[str, Any],
    config: dict[str, Any],
    settings: dict[str, Any],
    *,
    fallback_title: str,
    nudge: bool,
    holder: _LockHolder,
) -> None:
    """Store the settings and let a changed title reach the report and the loop.

    With `nudge`, the room's screen is told to reload once the write is durable:
    it follows its settings (tabs, QR, labels) on that nudge.
    """
    report_id = str(report["id"])
    await write_config_settings(config, settings, holder=holder)
    if settings["title"] != fallback_title:
        await async_directus.update_item(
            "project_report", report_id, {"user_instructions": settings["title"]}
        )
        loop = await get_loop_for_report(report_id)
        if loop:
            await async_directus.update_item(
                "agent_loop", str(loop["id"]), {"name": settings["title"]}
            )
    if nudge:
        await _invalidate_and_nudge(report_id)


def translation_target(settings: dict[str, Any], project: dict[str, Any]) -> str:
    """The language the results are translated into once the policy is resolved."""
    resolved = resolve_presentation_settings(settings, project)
    return str((resolved.get("language") or {}).get("translate_to") or "")


def translation_targets(settings: dict[str, Any], project: dict[str, Any]) -> list[str]:
    """Every language a tick owes, the results' language first."""
    return target_languages(resolve_presentation_settings(settings, project))


async def retarget_translation(
    report: dict[str, Any],
    *,
    before: dict[str, Any],
    after: dict[str, Any],
    project: dict[str, Any],
    project_after: dict[str, Any] | None = None,
    nudge: bool = False,
    require_loop: bool = True,
) -> bool:
    """Translate into a newly chosen language now, not at the next scheduled read.

    The settings around the change are resolved against the project, or against
    `project_after` as well when the project row itself is what changed. With
    `nudge`, the cached bundle is dropped and the room told to reload before the
    tick is dispatched. Returns whether the languages changed: adding a popcorn
    language is work owed just like picking another language for the results.
    """
    targets = translation_targets(after, project_after or project)
    if not targets or set(targets) == set(translation_targets(before, project)):
        return False
    report_id = str(report["id"])
    if nudge:
        await _invalidate_and_nudge(report_id)
    loop = await get_loop_for_report(report_id)
    if not loop:
        if require_loop:
            raise LoopNotFound("Popcorn loop not found")
        return True
    await dispatch_popcorn_tick_now_with_safety(str(loop["id"]), "translation")
    return True


async def go_live(loop: dict[str, Any], *, hours: int) -> dict[str, Any]:
    """Live: the two-minute chain until the expiry, reading straight away.
    Stop live, or the expiry, returns the session to manual."""
    if hours not in LIVE_HOURS:
        raise ValueError(f"hours must be one of {LIVE_HOURS}")
    loop_id = str(loop["id"])
    expires_at = (_now() + timedelta(hours=hours)).isoformat()
    updated = _data(
        await async_directus.update_item(
            "agent_loop",
            loop_id,
            {"status": "active", "expires_at": expires_at, "failure_count": 0},
        )
    )
    await dispatch_popcorn_tick_now_with_safety(loop_id, "manual")
    return updated


async def stop_live(loop: dict[str, Any]) -> dict[str, Any]:
    """Back to manual: nothing scheduled, the deck stays, refresh still works."""
    loop_id = str(loop["id"])
    await cancel_pending_popcorn_ticks(loop_id)
    return _data(
        await async_directus.update_item(
            "agent_loop", loop_id, {"status": "paused", "expires_at": _now().isoformat()}
        )
    )


async def request_rerun(loop: dict[str, Any]) -> None:
    """Wipe the live state (phrases, quotes, analysis) and read everything
    again. The wipe itself happens inside the tick, under the run lock, so a
    rerun pressed while a read is running is not undone by that read's own
    write. The run counter continues and the saved runs are kept."""
    await dispatch_popcorn_tick_now_with_safety(str(loop["id"]), "rerun")


async def readiness(*, project_id: str, acting_directus_user_id: str) -> dict[str, int]:
    """What a first read would find: conversations with a transcript, and the
    words in them (the dashboard says minutes, at 150 a minute)."""
    transcripts = await gather_transcripts(
        project_id=project_id, acting_directus_user_id=acting_directus_user_id
    )
    return {
        "conversations": len(transcripts),
        "words": sum(len(str(t.get("text") or "").split()) for t in transcripts),
    }


async def ensure_public_token(report: dict[str, Any]) -> str:
    token = str(report.get("public_token") or "")
    if token:
        return token
    token = secrets.token_urlsafe(24)
    await async_directus.update_item("project_report", str(report["id"]), {"public_token": token})
    report["public_token"] = token
    return token


async def get_report_by_public_token(token: str) -> dict[str, Any] | None:
    if not token or len(token) < 16:
        return None
    rows = await async_directus.get_items(
        "project_report",
        {
            "query": {
                "filter": {
                    "public_token": {"_eq": token},
                    "kind": {"_eq": REPORT_KIND},
                    "deleted_at": {"_null": True},
                },
                "limit": 1,
            }
        },
    )
    return rows[0] if isinstance(rows, list) and rows else None


# ── read models ──────────────────────────────────────────────────────


async def next_read_at(loop_id: str) -> str | None:
    """When the next tick is due: the earliest pending scheduled tick for the
    loop. A time in the past means a tick is being run right now."""
    from dembrane.scheduled_tasks import STATUS_SCHEDULED, STATUS_PROCESSING

    rows = await async_directus.get_items(
        "scheduled_task",
        {
            "query": {
                "filter": {
                    "task_type": {"_eq": TASK_POPCORN_TICK},
                    "status": {"_in": [STATUS_SCHEDULED, STATUS_PROCESSING]},
                },
                "fields": ["payload", "scheduled_at"],
                "limit": -1,
            }
        },
    )
    times = sorted(
        str(row.get("scheduled_at"))
        for row in (rows if isinstance(rows, list) else [])
        if isinstance(row, dict)
        and (row.get("payload") or {}).get("loop_id") == loop_id
        and row.get("scheduled_at")
    )
    return times[0] if times else None


def loop_payload(
    loop: dict[str, Any] | None,
    run: dict[str, Any] | None,
    next_at: str | None = None,
) -> dict[str, Any] | None:
    if not loop:
        return None
    return {
        "id": str(loop.get("id")),
        "status": loop.get("status"),
        "mode": loop_mode(loop),
        "expires_at": loop.get("expires_at"),
        "cadence_minutes": loop.get("cadence_minutes"),
        "next_read_at": next_at,
        "last_run_started_at": (run or {}).get("started_at"),
        "last_run_status": (run or {}).get("status"),
        "last_run_detail": (run or {}).get("detail"),
    }


async def load_settings_for(report: dict[str, Any]) -> dict[str, Any]:
    """The report's presentation settings, normalised."""
    config = await get_latest_config(str(report["id"]))
    return normalize_settings(
        (config or {}).get("popcorn_settings"),
        fallback_title=str(report.get("user_instructions") or "Popcorn"),
    )


def state_counts(state: dict[str, Any]) -> dict[str, Any]:
    conversations = state.get("conversations") or {}
    phrases = sum(len(c.get("items") or []) for c in conversations.values())
    done = sum(1 for c in conversations.values() if c.get("done"))
    analysis = state.get("analysis") or {}
    return {
        "conversations": len(conversations),
        "conversations_read": done,
        "reading": len(conversations) - done,
        "phrases": phrases,
        "validated": sum(
            1 for c in conversations.values() for i in (c.get("items") or []) if i.get("quoteId")
        ),
        "held_back": sum(
            len((c.get("review") or {}).get("dropped") or []) for c in conversations.values()
        ),
        "quotes": len(state.get("quotes") or []),
        "tensions": len((analysis.get("tensions") or {}).get("tensions") or []),
        "stakeholders": len((analysis.get("stakeholders") or {}).get("stakeholders") or []),
        "analysis_updated_at": analysis.get("updated_at"),
        "run": state.get("run"),
    }


async def popcorn_payload(
    report: dict[str, Any], *, capture: dict[str, Any] | None = None
) -> dict[str, Any]:
    """The session as the dashboard reads it.

    With `capture`, the rows this read already fetched are handed back in it.
    A caller that needs the extraction state or the newest run itself then
    costs no second read of the same loop.
    """
    report_id = str(report["id"])
    loop = await get_loop_for_report(report_id)
    run = await get_latest_run(str(loop["id"])) if loop else None
    config = await get_latest_config(report_id)
    fallback_title = str(report.get("user_instructions") or "Popcorn")
    settings = normalize_settings(
        (config or {}).get("popcorn_settings"), fallback_title=fallback_title
    )
    state = normalize_state((loop or {}).get("popcorn_state"))
    if capture is not None:
        capture.update({"loop": loop, "run": run, "config": config, "state": state})
    return {
        "id": report_id,
        "kind": REPORT_KIND,
        "project_id": _as_id(report.get("project_id")),
        "name": settings["title"],
        "created_at": report.get("date_created"),
        "updated_at": (loop or {}).get("updated_at"),
        "settings": settings,
        # A synthetic demo's disclosure and notice are the demo's; the
        # dashboard leaves them out.
        "synthetic": is_synthetic_session(state),
        "public_token": report.get("public_token"),
        "loop": loop_payload(loop, run, await next_read_at(str(loop["id"])) if loop else None),
        "counts": state_counts(state),
    }


def _session_day(value: Any) -> str:
    parsed = _parse_dt(value) or _now()
    return parsed.date().isoformat()


def _session_date(value: Any) -> str:
    text = str(value or "").replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        parsed = _now()
    return f"{parsed.day} {parsed.strftime('%B %Y')}"


def conversation_url(project: dict[str, Any], conversation_id: str, admin_base_url: str) -> str:
    workspace_id = _as_id(project.get("workspace_id")) or ""
    project_id = _as_id(project.get("id")) or ""
    return (
        f"{admin_base_url.rstrip('/')}/en-US/w/{workspace_id}/projects/{project_id}"
        f"/conversations/{conversation_id}"
    )


def build_bundle(
    *,
    state: dict[str, Any],
    settings: dict[str, Any],
    report: dict[str, Any],
    project: dict[str, Any],
    participant_base_url: str,
    admin_base_url: str = "",
    host: bool = False,
    dev: bool = False,
) -> dict[str, Any]:
    """Everything the presentation polls, as one document keyed by the file
    paths the page would otherwise fetch. A hidden tab is simply a missing file.

    The host variant adds what the room must not see: the names typed on the
    phones, the closest transcript passage behind every unverified phrase, and
    links into the dashboard. Nothing under an item's `review` leaves here."""
    files: dict[str, Any] = {}
    conversations = state.get("conversations") or {}
    order = [cid for cid in state.get("order") or [] if cid in conversations]
    analysis = state.get("analysis") or {}
    run = int(state.get("run") or 0)
    show_names = host or settings.get("public_labels") == "names"

    session: dict[str, Any] = {
        "title": settings["title"],
        "client": settings.get("client") or "",
        "date": _session_date(report.get("date_created")),
        "branding": bool(settings.get("show_branding", True)),
        "intro": settings.get("intro") or {},
        "transcripts": [
            _transcript_entry(conversations[cid], cid, index, show_names)
            for index, cid in enumerate(order, start=1)
        ],
    }
    demo = state.get("demo") or {}
    if demo.get("synthetic") is True:
        session["demo"] = {
            "synthetic": True,
            "public_sources_only": demo.get("public_sources_only") is True,
            "language": "nl" if demo.get("language") == "nl" else "en",
        }
    session.update(opening_screens(settings, demo))
    session["language"] = screen_language(settings, demo, project)
    session["date_iso"] = _session_day(report.get("date_created"))
    if (settings.get("data") or {}).get("enabled"):
        session["data"] = data_screen(project, session["language"])
    if settings.get("show_qr"):
        # A demo's QR opens dembrane's sales portal, a separate project that
        # records feedback for the dembrane team, in the screen's language
        # where there is one. Nothing recorded there reaches the demo project.
        portals = demo.get("portal_urls") or {}
        url = (
            portals.get(session["language"]) or demo.get("portal_url")
            if demo.get("synthetic")
            else participant_url(project, participant_base_url)
        )
        if url:
            session["qr"] = {"url": url, "svg": qr_svg_markup(url)}
            if demo.get("synthetic"):
                session["qr"]["label"] = (
                    "Feedback voor dembrane"
                    if session["language"] == "nl"
                    else "Feedback for dembrane"
                )
    if host:
        # What the host can switch on or off from the preview itself.
        session["host"] = {
            "tabs": {
                tab: bool((settings.get("tabs") or {}).get(tab, True)) for tab in TOGGLEABLE_TABS
            },
            "qr": bool(settings.get("show_qr")),
            "qrAvailable": participant_url(project, participant_base_url) is not None,
        }
        if dev:
            # Local development only: the deck's footer links to the account of
            # what the tick does, served beside the view.
            session["host"]["flow"] = "flow/"
    files["session.json"] = session

    for cid in order:
        conv = conversations[cid]
        items_out: list[dict[str, Any]] = []
        for item in conv.get("items") or []:
            if not isinstance(item, dict) or not item.get("phrase"):
                continue
            entry: dict[str, Any] = {"id": item["id"], "phrase": item["phrase"]}
            if demo.get("synthetic"):
                entry["synthetic"] = True
            if item.get("question"):
                entry["question"] = True
            # The phrase itself is in the transcript word for word: the deck
            # may draw it in quotation marks. A rooted paraphrase is not a
            # quotation; it opens its passage without the marks.
            if item.get("verbatim"):
                entry["verbatim"] = True
            if item.get("kind"):
                entry["kind"] = item["kind"]
                entry["qualifiers"] = [str(q) for q in (item.get("qualifiers") or [])]
            if item.get("quoteId"):
                entry["quoteId"] = item["quoteId"]
            if host and isinstance(item.get("source"), dict) and not item.get("quoteId"):
                entry["source"] = {
                    "text": item["source"].get("text"),
                    "url": conversation_url(project, cid, admin_base_url)
                    if admin_base_url
                    else None,
                }
            items_out.append(entry)
        popcorn_file: dict[str, Any] = {
            "transcript": cid,
            "revision": int(conv.get("revision") or 1),
            "done": bool(conv.get("done")),
            # The second pass finished for the transcript as it stands. Not every
            # phrase has a quote; the page may stop polling the file either way.
            "validated": bool(conv.get("done"))
            and bool(conv.get("fingerprint"))
            and conv.get("validated_fingerprint") == conv.get("fingerprint"),
            # Phrases the second pass could not root: a count for the tally,
            # never their text, in either bundle.
            "held_back": len((conv.get("review") or {}).get("dropped") or []),
            "items": items_out,
        }
        if host and int(conv.get("clipped") or 0) > 0:
            # A runaway recording: the model read the most recent window only.
            popcorn_file["coverage"] = {
                "chars": int(conv.get("chars") or 0),
                "clipped": int(conv.get("clipped") or 0),
            }
        files[f"popcorn/{cid}.json"] = popcorn_file
        if demo.get("synthetic"):
            popcorn_file["synthetic"] = True

    tabs = settings.get("tabs") or {}
    registry = state.get("quotes") or []
    if registry or analysis:
        quotes = []
        for quote in registry:
            entry = dict(quote)
            # A registry written before the attribution rule may still carry a
            # speaker in its context; the bundle is the last door it must not pass.
            if entry.get("context") and attributes(str(entry["context"])):
                entry.pop("context", None)
            if host and admin_base_url and quote.get("transcript"):
                entry["url"] = conversation_url(project, str(quote["transcript"]), admin_base_url)
            quotes.append(entry)
        files["quotes.json"] = {"quotes": quotes}
    if analysis:
        for kind in TOGGLEABLE_TABS:
            slide = analysis.get(kind)
            if tabs.get(kind, True) and isinstance(slide, dict):
                files[f"{kind}.json"] = (
                    {**slide, "synthetic": True} if demo.get("synthetic") else slide
                )

    return {"run": run, "files": mark_synthetic_files(files)}


def opening_screens(settings: dict[str, Any], demo: dict[str, Any]) -> dict[str, Any]:
    """The disclosure and notice the room sees, present only when switched on
    and worded. A synthetic demo's come with the demo, never from the host's
    settings: always on, in the demo's words or the standard ones."""
    if demo.get("synthetic") is True:
        copy = SYNTHETIC_COPY["nl" if demo.get("language") == "nl" else "en"]
        own: dict[str, Any] = demo.get("disclosure") or {}
        invitation: dict[str, Any] = (
            own
            if own.get("invitation_title") or own.get("invitation_text")
            else {
                "invitation_title": copy["invitation_title"],
                "invitation_text": copy["invitation_text"],
            }
        )
        demo_notice: dict[str, Any] = demo.get("notice") or {}
        return {
            "disclosure": {
                "text": str(own.get("text") or copy["disclosure"]),
                "invitation_title": str(invitation.get("invitation_title") or ""),
                "invitation_text": str(invitation.get("invitation_text") or ""),
            },
            "notice": {"text": str(demo_notice.get("text") or copy["notice"])},
        }
    disclosure = settings.get("disclosure") or {}
    notice = settings.get("notice") or {}
    screens: dict[str, Any] = {}
    if disclosure.get("enabled") and disclosure.get("text"):
        screens["disclosure"] = {
            key: disclosure.get(key) or ""
            for key in ("text", "invitation_title", "invitation_text")
        }
    if notice.get("enabled") and notice.get("text"):
        screens["notice"] = {"text": notice["text"]}
    return screens


def is_synthetic_session(state: dict[str, Any]) -> bool:
    return (state.get("demo") or {}).get("synthetic") is True


def data_screen(project: dict[str, Any], language: str) -> dict[str, Any]:
    """What happens to the room's data, from the project's own settings.
    `project["legal_basis"]` is the effective basis when the caller resolved
    it; a bare project row falls back to the platform default."""
    copy = DATA_COPY.get(language, DATA_COPY["en"])
    talk = "talk-anon" if project.get("anonymize_transcripts") else "talk-public"
    basis = str(project.get("legal_basis") or DEFAULT_LEGAL_BASIS)
    screen: dict[str, Any] = {
        "title": copy["title"],
        "steps": [
            {"image": "scan", "text": copy["scan"]},
            {"image": talk, "text": copy[talk]},
            {"image": "understand", "text": copy["understand"]},
        ],
        "notes": [text for text in (copy["legal"].get(basis), copy["hood"]) if text],
        "links": [copy["trust"]],
    }
    policy = project.get("privacy_policy_url")
    if (
        basis == "consent"
        and isinstance(policy, str)
        and policy.startswith(("https://", "http://"))
    ):
        screen["links"].insert(0, {"url": policy, "label": copy["policy"]})
    return screen


def mark_synthetic_files(files: dict[str, Any]) -> dict[str, Any]:
    """Keep provenance on individual files, including published-object overlays."""
    if not ((files.get("session.json") or {}).get("demo") or {}).get("synthetic"):
        return files
    result = {}
    for name, file in files.items():
        if not isinstance(file, dict):
            result[name] = file
            continue
        marked = {**file, "synthetic": True}
        for key in ("items", "quotes", "tensions", "stakeholders", "relations", "transcripts"):
            if isinstance(file.get(key), list):
                marked[key] = [
                    {**entry, "synthetic": True} if isinstance(entry, dict) else entry
                    for entry in file[key]
                ]
        result[name] = marked
    return result


def room_files(files: dict[str, Any], *, neutral_labels: bool) -> dict[str, Any]:
    """A saved run as the room may see it. Runs saved before September 6th
    2026 hold the host's bundle; this strips what the host alone may see (the
    passages, the dashboard links, the host block, the coverage) and numbers
    the legend when the setting says so. Newer runs are saved as the room's
    bundle and pass through unchanged."""
    out: dict[str, Any] = {}
    for name, file in files.items():
        if not isinstance(file, dict):
            out[name] = file
            continue
        if name == "session.json":
            session = {k: v for k, v in file.items() if k != "host"}
            transcripts = []
            for index, t in enumerate(session.get("transcripts") or [], start=1):
                if not isinstance(t, dict):
                    continue
                if neutral_labels:
                    t = {**t, "label": f"Conversation {index}", "short": f"Conversation {index}"}
                transcripts.append(t)
            session["transcripts"] = transcripts
            out[name] = session
        elif name.startswith("popcorn/"):
            out[name] = {
                **{k: v for k, v in file.items() if k != "coverage"},
                "items": [
                    {k: v for k, v in i.items() if k != "source"} if isinstance(i, dict) else i
                    for i in file.get("items") or []
                ],
            }
        elif name == "quotes.json":
            out[name] = {
                **file,
                "quotes": [
                    {k: v for k, v in q.items() if k != "url"} if isinstance(q, dict) else q
                    for q in file.get("quotes") or []
                ],
            }
        else:
            out[name] = file
    return out


def _transcript_entry(
    conv: dict[str, Any], cid: str, index: int, show_names: bool
) -> dict[str, Any]:
    """One legend entry. With names hidden the label is a number in deck order;
    `time` and `duration` let the timeline place the conversation's phrases."""
    name = str(conv.get("label") or "").strip() if show_names else ""
    if name:
        label = name
        short = str(conv.get("short") or "").strip() or name
    else:
        label = f"Conversation {index}"
        short = label
    entry: dict[str, Any] = {"id": cid, "label": label, "short": short}
    created_at = conv.get("created_at")
    if isinstance(created_at, str) and created_at:
        entry["time"] = created_at
    duration = conv.get("duration")
    if isinstance(duration, (int, float)) and not isinstance(duration, bool) and duration > 0:
        entry["duration"] = float(duration)
    return entry


def sample_bundle() -> dict[str, Any]:
    """Upstream's fictional Sorted Collaboration deck, for trying popcorn with no
    conversations and no model call."""
    import json
    from pathlib import Path

    root = Path(__file__).with_name("static") / "sample"
    files: dict[str, Any] = {}
    for path in sorted(root.rglob("*.json")):
        files[path.relative_to(root).as_posix()] = json.loads(path.read_text(encoding="utf-8"))
    return {"run": 0, "sample": True, "files": files}
