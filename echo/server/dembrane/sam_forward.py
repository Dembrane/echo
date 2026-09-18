"""One wire to sam, shared by every outbox that forwards to it.

Sam posts what it receives into #gen-engineering. Delivery is at-least-once:
sam deduplicates on the payload `id`, so a caller may redeliver after a crash
or a non-2xx. Each outbox owns its own stamp column and stamps only on
"delivered".
"""

from typing import Any, Dict, Tuple, Literal, Optional
from logging import Logger

import requests

from dembrane.settings import get_settings

SamOutcome = Literal["delivered", "retry", "rejected"]


def sam_webhook_config() -> Optional[Tuple[str, str]]:
    """(url, token), or None unless both are set (the local default)."""
    support = get_settings().support
    url, token = support.forward_webhook_url, support.forward_webhook_token
    if not url or not token:
        return None
    return url, token


def sam_environment() -> str:
    """Name the environment this deployment is, for the support payload.

    Same exact-host derivation as analytics._resolve_posthog_token — the
    admin dashboard URL is the one per-env value every deployment already
    has, so no new env var (ISSUE-034 design). Unknown hosts (previews,
    local with a configured webhook) report the host itself — sam's
    receiver forwards what it gets, so an honest odd label beats a wrong
    known one.
    """
    from urllib.parse import urlparse

    raw = (get_settings().urls.admin_base_url or "").lower().strip()
    host = urlparse(raw if "://" in raw else f"https://{raw}").hostname or ""
    if host == "dashboard.dembrane.com":
        return "production"
    if host == "dashboard.echo-next.dembrane.com":
        return "echo-next"
    return host or "development"


def post_to_sam(payload: Dict[str, Any], log: Logger) -> SamOutcome:
    """POST one payload to sam.

    delivered: 2xx, delivered-or-duplicate, stamp it.
    rejected: 4xx payload/config bug, leave unstamped and keep going.
    retry: receiver down or unreachable, stop the batch and retry next run.
    """
    config = sam_webhook_config()
    if config is None:
        return "retry"
    webhook_url, webhook_token = config
    try:
        response = requests.post(
            webhook_url,
            json=payload,
            headers={"X-Echo-Support-Token": webhook_token},
            timeout=(10, 30),
        )
    except requests.RequestException as e:
        log.warning("sam forward: POST failed (%s); stopping batch, next run retries", e)
        return "retry"

    if 200 <= response.status_code < 300:
        return "delivered"
    if 400 <= response.status_code < 500:
        log.error(
            "sam forward: %s rejected with %s (%s), payload/config bug, "
            "row stays unstamped until it's fixed",
            payload.get("id"),
            response.status_code,
            response.text[:200],
        )
        return "rejected"
    log.warning(
        "sam forward: receiver returned %s; stopping batch, next run retries",
        response.status_code,
    )
    return "retry"
