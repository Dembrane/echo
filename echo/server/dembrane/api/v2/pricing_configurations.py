"""POST /v2/pricing-configurations — the durable row behind the pricing configurator.

One row per attempt, keyed on `config_session_id`, written at the first answer
and updated on every step. The row is the durable record and the PostHog
events are only the shape of it: a dropped event costs a number, a dropped row
costs the answers, so the write happens before the booking opens and it never
depends on a browser beacon.

Two shapes arrive on this path, both defined by the client in
`frontend/src/components/pricing/submitConfiguration.ts`:

  * JSON, which is the normal case.
  * multipart/form-data when a transcription failed twice and the recording has
    to travel with the answers. The JSON sits in a `payload` part, and each
    recording rides beside it as `audio_<question_key>` with an
    `audio_<question_key>_duration_ms` part next to it.

The answers are written first and the audio is stored second, so a storage
failure costs the recording and never the lead. When it fails the response
says so in `warnings`, and the attempt is recorded on the row rather than
disappearing.

The booking takes the same path. When cal.com confirms one inside the page the
client posts the same session id again carrying `booking_uid`, `booking_status`
and `booking_start`, so a booking is an update to the row that already holds
the answers rather than a second record of the same person.

Identity is read from the session, never from the payload. The gate only
renders for a logged-in host, so an unauthenticated call is rejected.
"""

from __future__ import annotations

import json
import secrets
from typing import Any, Literal, Optional
from logging import getLogger

import httpx
from fastapi import Request, APIRouter, HTTPException
from pydantic import Field, BaseModel, ValidationError

from dembrane.utils import generate_uuid
from dembrane.app_user import get_directus_user_profile
from dembrane.api.rate_limit import create_user_rate_limiter
from dembrane.directus_async import async_directus
from dembrane.api.dependency_auth import DependencyDirectusSession

router = APIRouter()
logger = getLogger("api.v2.pricing_configurations")

COLLECTION = "pricing_configuration"

# One boolean, set from the login domain at the moment of the write, never
# guessed later. Deciding it at query time gets internal traffic wrong once an
# account is renamed or a test account is reused.
INTERNAL_EMAIL_DOMAIN = "@dembrane.com"

# DEM-XXXX. Ambiguous glyphs are out (0/O, 1/I/L), because the code is read
# out loud and typed back.
_REFERENCE_PREFIX = "DEM-"
_REFERENCE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
_REFERENCE_LENGTH = 4
_REFERENCE_ATTEMPTS = 8

# Every step writes, so the ceiling has to clear six steps, a submit and a
# retry with room to spare. It is here to stop a loop, not to ration the form.
_rate_limiter = create_user_rate_limiter(
    name="pricing_configuration", capacity=120, window_seconds=3600
)

# A recording that failed to transcribe twice. Bigger than any single answer
# needs, small enough that the endpoint cannot be used as a file host.
MAX_AUDIO_BYTES = 25 * 1024 * 1024
MAX_ATTACHMENTS = 6


class PricingConfigurationRequest(BaseModel):
    """Exactly the JSON body the client sends. Nothing here is trusted for
    identity: email, user and the internal flag are read from the session."""

    config_session_id: str = Field(min_length=1, max_length=255)
    question_set_version: str = Field(default="", max_length=255)
    config_shape_version: Optional[int] = None
    mount: Literal["app", "site"] = "app"
    locale: str = Field(default="", max_length=255)
    wall_key: Optional[str] = Field(default=None, max_length=255)
    workspace_id: Optional[str] = Field(default=None, max_length=255)
    org_id: Optional[str] = Field(default=None, max_length=255)
    project_id: Optional[str] = Field(default=None, max_length=255)
    answers_raw: dict[str, Any] = Field(default_factory=dict)
    config: dict[str, Any] = Field(default_factory=dict)
    status: Literal["in_progress", "submitted"] = "in_progress"
    # The booking, reported by the booking step after cal.com confirms one.
    # Absent on every write before that, and absence is what keeps a step write
    # from touching the booking columns at all.
    booking_uid: Optional[str] = Field(default=None, max_length=255)
    booking_status: Optional[str] = Field(default=None, max_length=255)
    booking_start: Optional[str] = Field(default=None, max_length=255)


class PricingConfigurationResponse(BaseModel):
    """`reference` is the whole contract the client reads. `warnings` carries
    anything that degraded without costing the answers, which today means a
    recording that could not be stored."""

    reference: str
    warnings: list[str] = Field(default_factory=list)


class _Attachment(BaseModel):
    question_key: str
    filename: str
    content_type: str
    duration_ms: Optional[int] = None
    content: bytes


def _new_reference() -> str:
    body = "".join(secrets.choice(_REFERENCE_ALPHABET) for _ in range(_REFERENCE_LENGTH))
    return f"{_REFERENCE_PREFIX}{body}"


def _clean(value: Optional[str]) -> Optional[str]:
    """Empty strings become NULL, so "unanswered" and "sent as blank" read the
    same way in a query."""
    if value is None:
        return None
    trimmed = value.strip()
    return trimmed or None


async def _read_body(request: Request) -> tuple[dict[str, Any], list[_Attachment]]:
    """Return the JSON payload and any recordings that travelled with it.

    Multipart is detected from the content type, which is what the client sets.
    A malformed body is a 400 here rather than a 500 further down.
    """
    content_type = (request.headers.get("content-type") or "").lower()

    if not content_type.startswith("multipart/form-data"):
        try:
            body = await request.json()
        except Exception as exc:
            raise HTTPException(status_code=400, detail="Body is not valid JSON") from exc
        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail="Body must be a JSON object")
        return body, []

    form = await request.form()
    raw_payload = form.get("payload")
    if not isinstance(raw_payload, str):
        raise HTTPException(
            status_code=400, detail="Multipart body needs a `payload` part holding the JSON"
        )
    try:
        body = json.loads(raw_payload)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="`payload` is not valid JSON") from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="`payload` must be a JSON object")

    attachments: list[_Attachment] = []
    for key, value in form.multi_items():
        if not key.startswith("audio_") or key.endswith("_duration_ms"):
            continue
        # A str here means the client sent a text part under an audio name.
        # Skip it rather than guessing: the answers still get stored.
        if isinstance(value, str):
            logger.warning("pricing configuration: %s arrived as text, skipped", key)
            continue
        if len(attachments) >= MAX_ATTACHMENTS:
            logger.warning("pricing configuration: more than %s recordings, rest dropped", MAX_ATTACHMENTS)
            break

        question_key = key[len("audio_") :]
        content = await value.read()
        if len(content) > MAX_AUDIO_BYTES:
            logger.warning(
                "pricing configuration: recording for %s is %s bytes, over the cap",
                question_key,
                len(content),
            )
            content = b""

        raw_duration = form.get(f"audio_{question_key}_duration_ms")
        duration_ms: Optional[int] = None
        if isinstance(raw_duration, str) and raw_duration.strip().isdigit():
            duration_ms = int(raw_duration.strip())

        attachments.append(
            _Attachment(
                question_key=question_key,
                filename=value.filename or f"{question_key}.webm",
                content_type=value.content_type or "audio/webm",
                duration_ms=duration_ms,
                content=content,
            )
        )

    return body, attachments


def _flat_mirrors(config: dict[str, Any]) -> dict[str, Any]:
    """The four values a person scanning the collection needs without opening
    the JSON. Derived from `config` on the server, so the row and the events
    can never disagree about them."""
    volume = config.get("volume")
    concurrency = config.get("concurrency")
    exact = config.get("concurrency_exact")
    answered = config.get("answered")
    furthest = config.get("furthest_step")
    return {
        "volume_bucket": volume if isinstance(volume, str) else None,
        "concurrency_bucket": concurrency if isinstance(concurrency, str) else None,
        "concurrency_exact": exact if isinstance(exact, int) and not isinstance(exact, bool) else None,
        "answered_count": answered if isinstance(answered, int) and not isinstance(answered, bool) else None,
        "furthest_step": furthest if isinstance(furthest, int) and not isinstance(furthest, bool) else None,
    }


def _row_from(
    payload: PricingConfigurationRequest,
    *,
    email: Optional[str],
    user_id: str,
    is_internal: bool,
    status: str,
) -> dict[str, Any]:
    return {
        "config_session_id": payload.config_session_id.strip(),
        "status": status,
        "email": email,
        "user_id": user_id,
        "is_internal": is_internal,
        "locale": _clean(payload.locale),
        "mount": payload.mount,
        "wall_key": _clean(payload.wall_key),
        "workspace_id": _clean(payload.workspace_id),
        "org_id": _clean(payload.org_id),
        "project_id": _clean(payload.project_id),
        "question_set_version": _clean(payload.question_set_version),
        "config_shape_version": payload.config_shape_version,
        "answers_raw": payload.answers_raw,
        "config": payload.config,
        **_flat_mirrors(payload.config),
    }


# The booking column vocabulary is cal.com's, not ours. `booking_status` holds
# the word the event sent ("accepted", "cancelled", "pending"), lowercased, so
# a cancellation reads as a cancellation. The field's dropdown in Directus
# still offers none/opened/confirmed, which is the shape it was created with;
# the value is a plain varchar, so the raw word stores and displays.
def _booking_from(payload: PricingConfigurationRequest) -> Optional[dict[str, Any]]:
    """The booking this write reports, or None when it reports none.

    The uid is the whole test. Without it there is nothing to join a row to a
    booking on, so a status or a start time on its own is ignored rather than
    written into a row that cannot be reconciled later.
    """
    uid = _clean(payload.booking_uid)
    if not uid:
        return None
    status = _clean(payload.booking_status)
    return {
        "uid": uid,
        "status": status.lower() if status else None,
        "start": _clean(payload.booking_start),
    }


def _config_with_booking(
    config: dict[str, Any],
    existing: Optional[dict[str, Any]],
    booking: Optional[dict[str, Any]],
) -> dict[str, Any]:
    """The client's `config`, with the booking kept inside it under `booking`.

    The collection has `booking_uid` and `booking_status` columns and no column
    for the start time. Rather than spend a column on one timestamp, the start
    time lives here, beside the uid and status it belongs to, in the JSON the
    row already carries.

    The client owns `config` and sends the whole object on every write knowing
    nothing about this key, so a later step write would silently drop the
    booking. Whatever is stored is therefore carried forward unless this write
    is the one bringing a booking. A booking for the same uid is merged, so a
    status-only update keeps the start time; a different uid replaces it
    outright, because it is a different booking.
    """
    merged = dict(config)
    stored = (existing or {}).get("config")
    carried = None
    if isinstance(stored, dict) and isinstance(stored.get("booking"), dict):
        carried = stored["booking"]

    if booking is None:
        if carried:
            merged["booking"] = carried
        return merged

    entry: dict[str, Any] = {}
    if carried and carried.get("uid") == booking["uid"]:
        entry.update(carried)
    entry.update({key: value for key, value in booking.items() if value is not None})
    merged["booking"] = entry
    return merged


async def _find_by_session(config_session_id: str) -> Optional[dict[str, Any]]:
    rows = await async_directus.get_items(
        COLLECTION,
        {
            "query": {
                "filter": {"config_session_id": {"_eq": config_session_id}},
                "fields": [
                    "id",
                    "reference",
                    "status",
                    "user_id",
                    "voice_audio",
                    # `config` carries the booking start time, and the client
                    # sends `config` on every write knowing nothing about it,
                    # so it has to be read back to be carried forward.
                    "config",
                    "booking_uid",
                ],
                "limit": 1,
            }
        },
    )
    if isinstance(rows, list) and rows:
        return rows[0]
    return None


async def _insert(row: dict[str, Any]) -> dict[str, Any]:
    """Create the row, minting a reference that is stable for the life of the
    session. Two things can make the insert fail, and they are told apart by
    re-reading: another writer won the race on this session id (so the answer is
    that row), or a reference collided (so try another one)."""
    for _ in range(_REFERENCE_ATTEMPTS):
        candidate = {**row, "id": generate_uuid(), "reference": _new_reference()}
        try:
            created = await async_directus.create_item(COLLECTION, candidate)
            return created["data"]
        except Exception as exc:  # noqa: BLE001 — both failures are recoverable
            existing = await _find_by_session(row["config_session_id"])
            if existing:
                logger.info(
                    "pricing configuration: session %s was created by a concurrent write",
                    row["config_session_id"],
                )
                return existing
            logger.warning("pricing configuration: insert retry after %s", exc)
    raise HTTPException(status_code=500, detail="Could not allocate a reference")


@router.post("", response_model=PricingConfigurationResponse)
async def upsert_pricing_configuration(
    request: Request,
    auth: DependencyDirectusSession,
) -> PricingConfigurationResponse:
    """Store the answers, and give back the reference the booking carries.

    An upsert on `config_session_id`: every step of the form calls this, and one
    row grows. The reference is minted once and never changes, so the same
    session id always answers with the same code.
    """
    await _rate_limiter.check(auth.user_id)

    body, attachments = await _read_body(request)
    try:
        payload = PricingConfigurationRequest.model_validate(body)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.errors(include_url=False)) from None

    # ── identity, from the session and only from the session ──
    profile = await get_directus_user_profile(auth.user_id)
    email = ((profile or {}).get("email") or "").strip().lower() or None
    if email is None:
        # The email is the point of the row, so a session without one is worth
        # a line in the log. It still stores: losing the answers is worse.
        logger.warning("pricing configuration: no email on directus user %s", auth.user_id)
    is_internal = bool(email and email.endswith(INTERNAL_EMAIL_DOMAIN))

    session_id = payload.config_session_id.strip()
    existing = await _find_by_session(session_id)

    if existing and existing.get("user_id") and existing["user_id"] != auth.user_id:
        # Session ids are minted in the browser. Somebody else's answers are not
        # this caller's to overwrite.
        raise HTTPException(status_code=403, detail="This configuration belongs to another user")

    booking = _booking_from(payload)

    # `submitted` never falls back to `in_progress`. A late step write must not
    # make a finished configuration look abandoned, and a booking write can only
    # ever raise the status: nobody books a call on an attempt that was never
    # sent, so a booking arriving while the payload still says `in_progress` is
    # a client that fell behind, never a row going backwards.
    status = payload.status
    if booking or (existing and existing.get("status") == "submitted"):
        status = "submitted"

    row = _row_from(
        payload,
        email=email,
        user_id=auth.user_id,
        is_internal=is_internal,
        status=status,
    )
    row["config"] = _config_with_booking(payload.config, existing, booking)

    # The booking columns are written only by a write that reports a booking.
    # A step write leaves them out of the patch entirely, so it cannot blank a
    # booking the row already learned.
    if booking:
        previous_uid = (existing or {}).get("booking_uid")
        if previous_uid and previous_uid != booking["uid"]:
            # Two bookings on one session is a real thing, because a person can
            # rebook. It is also exactly what a bug looks like, so it is never
            # silent, and the newest one wins.
            logger.warning(
                "pricing configuration: session %s already carried booking %s and now "
                "reports %s; the newest wins",
                session_id,
                previous_uid,
                booking["uid"],
            )
            # The new booking has not been forwarded yet. Clearing the stamp
            # lets the outbox send it, rather than leaving the team holding a
            # time that has moved.
            row["booking_notified_at"] = None
        row["booking_uid"] = booking["uid"]
        if booking["status"]:
            row["booking_status"] = booking["status"]

    if existing:
        row_id = existing["id"]
        updated = await async_directus.update_item(COLLECTION, row_id, row)
        reference = (updated.get("data") or {}).get("reference") or existing.get("reference")
        if not reference:
            # Nothing should reach here; a row without a reference cannot be
            # quoted back, so mint one rather than leave the gap.
            reference = _new_reference()
            await async_directus.update_item(COLLECTION, row_id, {"reference": reference})
    else:
        created = await _insert(row)
        row_id = created["id"]
        reference = created.get("reference") or ""

    # ── the recordings, stored after the answers are safe ──
    warnings: list[str] = []
    if attachments:
        stored, warnings = await _store_attachments(attachments)
        existing_audio = (existing or {}).get("voice_audio")
        merged = _merge_audio(existing_audio, stored)
        try:
            await async_directus.update_item(COLLECTION, row_id, {"voice_audio": merged})
        except Exception:  # noqa: BLE001 — the answers are already stored
            logger.exception("pricing configuration: could not record audio metadata")
            warnings.append("The recording metadata could not be written to the row.")

    # TODO(server_pricing_config_submitted): the server mirror of
    # `pricing_config_submitted` belongs right here, on `status == "submitted"`,
    # through `dembrane.analytics.capture_event` with the lowercased login email
    # as `distinct_id` (the shape `onboarding.py` already uses).
    # It is BLOCKED and must not be emitted yet. `posthog.identify(data.email)`
    # in `Login.tsx` and `Register.tsx` has no `.toLowerCase()` while the server
    # lowercases, so the two land on different PostHog persons and the funnel
    # would double count. Ship it only after that one-line client fix lands.

    return PricingConfigurationResponse(reference=reference, warnings=warnings)


def _merge_audio(existing: Any, stored: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep one entry per question key, newest write wins. A retry that finally
    stores the recording replaces the record of the attempt that failed."""
    by_key: dict[str, dict[str, Any]] = {}
    if isinstance(existing, list):
        for entry in existing:
            if isinstance(entry, dict) and isinstance(entry.get("question_key"), str):
                by_key[entry["question_key"]] = entry
    for entry in stored:
        by_key[entry["question_key"]] = entry
    return list(by_key.values())


async def _store_attachments(
    attachments: list[_Attachment],
) -> tuple[list[dict[str, Any]], list[str]]:
    """Put each recording in Directus files and describe what happened.

    A failure here is recorded and reported, never raised: the answers are
    already stored, and a lost recording must not turn a saved lead into an
    error the person sees.
    """
    stored: list[dict[str, Any]] = []
    warnings: list[str] = []

    for attachment in attachments:
        entry: dict[str, Any] = {
            "question_key": attachment.question_key,
            "duration_ms": attachment.duration_ms,
            "stored": False,
        }
        if not attachment.content:
            entry["error"] = "empty or over the size cap"
            warnings.append(
                f"The recording for {attachment.question_key} was empty or too large, so it was not stored."
            )
            stored.append(entry)
            continue

        try:
            file_id = await _upload_to_directus(attachment)
            entry["stored"] = True
            entry["directus_file_id"] = file_id
        except Exception as exc:  # noqa: BLE001 — degrade, never fail the write
            logger.exception(
                "pricing configuration: storing the recording for %s failed",
                attachment.question_key,
            )
            entry["error"] = str(exc)[:300]
            warnings.append(
                f"The answers were saved. The recording for {attachment.question_key} could not be stored."
            )
        stored.append(entry)

    return stored, warnings


async def _upload_to_directus(attachment: _Attachment) -> str:
    """Upload one recording to Directus files with the admin token.

    Same route the whitelabel logo takes in `api/user_settings.py`. Directus
    files is the store behind `voice_audio_id`, and it needs no bucket of its
    own.
    """
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            f"{async_directus.url}/files",
            headers={"Authorization": f"Bearer {async_directus.token}"},
            files={
                "file": (
                    attachment.filename,
                    attachment.content,
                    attachment.content_type,
                )
            },
        )
    if response.status_code not in (200, 201):
        raise RuntimeError(f"directus /files returned {response.status_code}: {response.text[:200]}")
    return str(response.json()["data"]["id"])


# ── the answers in one plain line, for a reader who will not open the row ──
#
# The labels below are the English short forms of the questions in
# `frontend/src/components/pricing/questions.ts`. English only and on purpose:
# this is read by the team, not by the person who filled the form, so it does
# not follow their locale the way the booking note does.
#
# Only keys travel on the wire, never labels, so a renamed option in the
# question set changes this map and nothing else. A key that is not here falls
# through as itself, which keeps a new option readable instead of dropping the
# answer.

_SUMMARY_LABELS: dict[str, str] = {
    "use_case": "Use case",
    "timing": "Timing",
    "volume": "Volume",
    "concurrency": "At once",
    "extras": "Extras",
    "context": "Notes",
}

_SUMMARY_OPTIONS: dict[str, dict[str, str]] = {
    "use_case": {
        "event_workshop": "an event or a workshop",
        "assembly": "an assembly",
        "conference_sessions": "recording conference sessions",
        "in_person": "in person conversations",
        "audio_survey": "an audio survey",
        "something_else": "something else",
    },
    "volume": {
        "under_50": "under 50",
        "50_to_250": "50 to 250",
        "250_to_1000": "250 to 1000",
        "over_1000": "more than 1000",
        "not_sure": "not sure",
    },
    "concurrency": {
        "just_one": "just one",
        "2_to_5": "2 to 5",
        "6_to_15": "6 to 15",
        "16_to_40": "16 to 40",
        "more_than_40": "more than 40",
        "not_sure": "not sure",
    },
    "extras": {
        "event_help": "event help",
        "procurement_help": "procurement help",
    },
}

# One free text answer, and the whole summary. It rides in a chat message, so
# it stays one short line rather than a transcript.
_SUMMARY_TEXT_LIMIT = 160
_SUMMARY_LIMIT = 600


def _summary_text(value: Any, limit: int = _SUMMARY_TEXT_LIMIT) -> Optional[str]:
    """One line, whatever the person typed. Newlines collapse so the summary
    reads the same in a chat message as it does in a log."""
    if not isinstance(value, str):
        return None
    flat = " ".join(value.split())
    if not flat:
        return None
    return flat if len(flat) <= limit else f"{flat[: limit - 3].rstrip()}..."


def _summary_choices(question: str, chosen: Any, answers: dict[str, Any]) -> Optional[str]:
    labels = _SUMMARY_OPTIONS.get(question, {})
    keys = chosen if isinstance(chosen, list) else [chosen]
    parts: list[str] = []
    for key in keys:
        if not isinstance(key, str) or not key:
            continue
        label = labels.get(key, key)
        if key == "something_else":
            typed = _summary_text(answers.get("use_case_other"))
            if typed:
                label = f"{label}: {typed}"
        if key == "more_than_40":
            exact = _summary_text(answers.get("concurrency_exact"), 12)
            if exact and exact.isdigit():
                label = f"{label} ({exact})"
        parts.append(label)
    return ", ".join(parts) if parts else None


def build_answers_summary(answers_raw: Any) -> str:
    """What the person said, in one short English line.

    Reads `answers_raw`, which is exactly what the client sent, so a question
    set that has moved on still summarises an old row. A skipped question is
    absent rather than marked: a list of blanks tells a reader nothing.
    """
    if not isinstance(answers_raw, dict):
        return ""
    parts: list[str] = []
    for question, label in _SUMMARY_LABELS.items():
        raw = answers_raw.get(question)
        if question in _SUMMARY_OPTIONS:
            value = _summary_choices(question, raw, answers_raw)
        else:
            value = _summary_text(raw)
        if value:
            parts.append(f"{label}: {value}")
    line = " | ".join(parts)
    if len(line) <= _SUMMARY_LIMIT:
        return line
    return f"{line[: _SUMMARY_LIMIT - 3].rstrip()}..."
