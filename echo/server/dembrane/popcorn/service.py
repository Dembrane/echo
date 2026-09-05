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

import secrets
from typing import Any
from datetime import datetime, timezone, timedelta

from dembrane.utils import generate_uuid
from dembrane.popcorn.qr import qr_svg_markup
from dembrane.directus_async import async_directus
from dembrane.scheduled_tasks import TASK_POPCORN_TICK, schedule_task
from dembrane.popcorn.analysis import attributes

REPORT_KIND = "popcorn"
LOOP_KIND = "popcorn"
DEFAULT_CADENCE_MINUTES = 2
MIN_CADENCE_MINUTES = 1
MAX_CADENCE_MINUTES = 120
# How long live can be asked for, in hours.
LIVE_HOURS = (1, 8, 24)
STATE_VERSION = 2  # 2: one quote registry at the top of the state, validation per transcript

# Tabs the host can hide from the room. Popcorn itself is always shown: it is
# the opening screen and the reason the deck exists.
TOGGLEABLE_TABS = ("tensions", "stakeholders")

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
    tabs_value = raw.get("tabs")
    tabs_raw: dict[str, Any] = tabs_value if isinstance(tabs_value, dict) else {}
    return {
        "title": str(raw.get("title") or fallback_title).strip()[:160] or fallback_title,
        "client": str(raw.get("client") or "").strip()[:160],
        "tabs": {tab: bool(tabs_raw.get(tab, True)) for tab in TOGGLEABLE_TABS},
        "public": bool(raw.get("public", False)),
        "show_qr": bool(raw.get("show_qr", False)),
        # "made with dembrane" on the deck. Off is a Changemaker feature, like
        # whitelabel; the API enforces the tier, the setting only records it.
        "show_branding": bool(raw.get("show_branding", True)),
        "voice": normalize_voice(raw.get("voice")),
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
    loop_id: str, when: datetime | None = None, tick_kind: str = "scheduled"
) -> str:
    return await schedule_task(
        task_type=TASK_POPCORN_TICK,
        scheduled_at=when or _now(),
        payload={"loop_id": loop_id, "tick_kind": tick_kind},
    )


def dispatch_popcorn_tick_now(loop_id: str, tick_kind: str = "manual") -> None:
    """Hand a tick to a worker immediately instead of waiting for the scheduler poll."""
    from dembrane.tasks import task_popcorn_tick_now

    task_popcorn_tick_now.send(loop_id, tick_kind)


SAFETY_TICK_DELAY_SECONDS = 0


async def dispatch_popcorn_tick_now_with_safety(loop_id: str, tick_kind: str = "manual") -> None:
    """The direct actor plus a scheduled tick shortly after. On a worker whose
    async clients are bound to a foreign loop the direct actor dies before it
    writes a run; the scheduled one then lands within seconds instead of
    waiting for the five-minute reconciler. When both run, the run lock makes
    the second a harmless no-op."""
    dispatch_popcorn_tick_now(loop_id, tick_kind)
    await enqueue_popcorn_tick(
        loop_id,
        when=_now() + timedelta(seconds=SAFETY_TICK_DELAY_SECONDS),
        tick_kind=tick_kind,
    )


async def create_popcorn(
    *,
    project_id: str,
    title: str,
    client: str | None,
    acting_directus_user_id: str,
) -> dict[str, Any]:
    """Create the report row, its settings revision, the loop in manual mode,
    and one read straight away. Nothing is scheduled until the host goes live."""
    cadence = DEFAULT_CADENCE_MINUTES
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
    config = _data(
        await async_directus.create_item(
            "canvas_config_revision",
            {
                "id": generate_uuid(),
                "report_id": report_id,
                "brief": "",
                "gather_spec": {"full_history": True},
                "popcorn_settings": default_settings(title=title, client=client),
                "cadence_minutes": cadence,
                "created_by": acting_directus_user_id,
                "note": "initial",
            },
        )
    )
    loop = _data(
        await async_directus.create_item(
            "agent_loop",
            {
                "id": generate_uuid(),
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
    await dispatch_popcorn_tick_now_with_safety(str(loop["id"]), "manual")
    return {"report": report, "config": config, "loop": loop}


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


async def update_settings(
    *,
    report: dict[str, Any],
    patch: dict[str, Any],
) -> dict[str, Any]:
    """Update presentation settings in place. They are toggles, not analysis config,
    so they do not earn a new revision the way a canvas brief does."""
    report_id = str(report["id"])
    config = await get_latest_config(report_id)
    if not config:
        raise RuntimeError("Popcorn settings revision not found")
    fallback_title = str(report.get("user_instructions") or "Popcorn")
    current = normalize_settings(config.get("popcorn_settings"), fallback_title=fallback_title)
    merged = dict(current)
    for key in ("title", "client", "public", "show_qr", "show_branding", "public_labels"):
        if key in patch and patch[key] is not None:
            merged[key] = patch[key]
    if isinstance(patch.get("voice"), dict):
        merged["voice"] = {**current["voice"], **patch["voice"]}
    if isinstance(patch.get("tabs"), dict):
        merged["tabs"] = {
            **current["tabs"],
            **{k: bool(v) for k, v in patch["tabs"].items() if k in TOGGLEABLE_TABS},
        }
    settings = normalize_settings(merged, fallback_title=fallback_title)
    await async_directus.update_item(
        "canvas_config_revision", str(config["id"]), {"popcorn_settings": settings}
    )
    if settings["title"] != fallback_title:
        await async_directus.update_item(
            "project_report", report_id, {"user_instructions": settings["title"]}
        )
        loop = await get_loop_for_report(report_id)
        if loop:
            await async_directus.update_item(
                "agent_loop", str(loop["id"]), {"name": settings["title"]}
            )
    return settings


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


async def reset_for_rerun(loop: dict[str, Any]) -> dict[str, Any]:
    """Wipe the live state (phrases, quotes, analysis) and read again. The
    run counter continues so the saved runs stay in order; they are kept."""
    loop_id = str(loop["id"])
    previous = normalize_state(loop.get("popcorn_state"))
    state = fresh_state()
    state["run"] = previous["run"]
    await async_directus.update_item("agent_loop", loop_id, {"popcorn_state": state})
    await dispatch_popcorn_tick_now_with_safety(loop_id, "manual")
    return state


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


async def popcorn_payload(report: dict[str, Any]) -> dict[str, Any]:
    report_id = str(report["id"])
    loop = await get_loop_for_report(report_id)
    run = await get_latest_run(str(loop["id"])) if loop else None
    config = await get_latest_config(report_id)
    fallback_title = str(report.get("user_instructions") or "Popcorn")
    settings = normalize_settings(
        (config or {}).get("popcorn_settings"), fallback_title=fallback_title
    )
    state = normalize_state((loop or {}).get("popcorn_state"))
    return {
        "id": report_id,
        "kind": REPORT_KIND,
        "project_id": _as_id(report.get("project_id")),
        "name": settings["title"],
        "created_at": report.get("date_created"),
        "updated_at": (loop or {}).get("updated_at"),
        "settings": settings,
        "public_token": report.get("public_token"),
        "loop": loop_payload(loop, run, await next_read_at(str(loop["id"])) if loop else None),
        "counts": state_counts(state),
    }


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
        "transcripts": [
            _transcript_entry(conversations[cid], cid, index, show_names)
            for index, cid in enumerate(order, start=1)
        ],
    }
    if settings.get("show_qr"):
        url = participant_url(project, participant_base_url)
        if url:
            session["qr"] = {"url": url, "svg": qr_svg_markup(url)}
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
                files[f"{kind}.json"] = slide

    return {"run": run, "files": files}


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
