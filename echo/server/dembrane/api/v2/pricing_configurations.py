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


async def _find_by_session(config_session_id: str) -> Optional[dict[str, Any]]:
    rows = await async_directus.get_items(
        COLLECTION,
        {
            "query": {
                "filter": {"config_session_id": {"_eq": config_session_id}},
                "fields": ["id", "reference", "status", "user_id", "voice_audio"],
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

    # `submitted` never falls back to `in_progress`. A late step write must not
    # make a finished configuration look abandoned.
    status = payload.status
    if existing and existing.get("status") == "submitted":
        status = "submitted"

    row = _row_from(
        payload,
        email=email,
        user_id=auth.user_id,
        is_internal=is_internal,
        status=status,
    )

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
