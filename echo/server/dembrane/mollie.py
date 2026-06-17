"""Thin async Mollie API client (recurring payments / subscriptions).

Mollie has no plan/tier catalog: a subscription is just
`{amount, interval, description, metadata}` on a customer. We map our tier to
`amount = seats x per-seat price`. Test vs live is set by the API key prefix
(`test_` / `live_`). See docs/plans/self-serve-billing-and-payments.md.

This module is the transport only — no domain logic. The billing service layer
(linking customers/subscriptions to billing_account, reconciling status) lives
elsewhere so this stays a faithful, testable wrapper.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

import httpx

from dembrane.settings import get_settings

logger = logging.getLogger("mollie")

_BASE_URL = "https://api.mollie.com/v2"
_TIMEOUT = 20.0


class MollieError(RuntimeError):
    """Raised on a non-2xx Mollie response or missing configuration."""


def _api_key() -> str:
    key = get_settings().billing.mollie_api_key
    if not key:
        raise MollieError("MOLLIE_API_KEY is not configured")
    return key


def _amount(value_eur: float) -> dict[str, str]:
    return {"currency": "EUR", "value": f"{value_eur:.2f}"}


async def _request(method: str, path: str, json: Optional[dict] = None) -> dict:
    headers = {
        "Authorization": f"Bearer {_api_key()}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(base_url=_BASE_URL, headers=headers, timeout=_TIMEOUT) as client:
        resp = await client.request(method, path, json=json)
    if resp.status_code >= 400:
        raise MollieError(f"Mollie {method} {path} -> {resp.status_code}: {resp.text[:300]}")
    # DELETE subscription returns the (canceled) object; all return JSON.
    return resp.json() if resp.content else {}


# ── Customers ────────────────────────────────────────────────────────


async def create_customer(*, name: str, email: str, metadata: Optional[dict] = None) -> dict:
    body: dict[str, Any] = {"name": name, "email": email}
    if metadata:
        body["metadata"] = metadata
    return await _request("POST", "/customers", json=body)


# ── First payment (consent -> mandate) ───────────────────────────────


async def create_first_payment(
    *,
    customer_id: str,
    amount_eur: float,
    description: str,
    redirect_url: str,
    webhook_url: str,
    metadata: Optional[dict] = None,
) -> dict:
    """Create the consent ('first') payment. The hosted checkout URL is at
    `_links.checkout.href`. Completing it yields a reusable mandate."""
    body: dict[str, Any] = {
        "amount": _amount(amount_eur),
        "customerId": customer_id,
        "sequenceType": "first",
        "description": description,
        "redirectUrl": redirect_url,
        "webhookUrl": webhook_url,
    }
    if metadata:
        body["metadata"] = metadata
    return await _request("POST", "/payments", json=body)


async def get_payment(payment_id: str) -> dict:
    """Fetch a payment. Always re-fetch on webhook — never trust the payload."""
    return await _request("GET", f"/payments/{payment_id}")


def checkout_url(payment: dict) -> Optional[str]:
    return (((payment or {}).get("_links") or {}).get("checkout") or {}).get("href")


# ── Subscriptions ────────────────────────────────────────────────────


async def create_subscription(
    *,
    customer_id: str,
    amount_eur: float,
    interval: str,
    description: str,
    webhook_url: str,
    metadata: Optional[dict] = None,
) -> dict:
    """Create a recurring subscription. `amount` is the full per-interval charge
    (= seats x per-seat price; no quantity field). `interval` like '1 month' or
    '12 months'. `description` must be unique per customer."""
    body: dict[str, Any] = {
        "amount": _amount(amount_eur),
        "interval": interval,
        "description": description,
        "webhookUrl": webhook_url,
    }
    if metadata:
        body["metadata"] = metadata
    return await _request("POST", f"/customers/{customer_id}/subscriptions", json=body)


async def update_subscription_amount(
    *, customer_id: str, subscription_id: str, amount_eur: float
) -> dict:
    """PATCH the subscription amount (e.g. when the seat count changes — Mollie
    has no quantity, so we recompute and set the new flat amount)."""
    return await _request(
        "PATCH",
        f"/customers/{customer_id}/subscriptions/{subscription_id}",
        json={"amount": _amount(amount_eur)},
    )


async def cancel_subscription(*, customer_id: str, subscription_id: str) -> dict:
    return await _request("DELETE", f"/customers/{customer_id}/subscriptions/{subscription_id}")
