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
    webhook_url: Optional[str] = None,
    metadata: Optional[dict] = None,
) -> dict:
    """Create the consent ('first') payment. The hosted checkout URL is at
    `_links.checkout.href`. Completing it yields a reusable mandate. `webhook_url`
    is optional — Mollie rejects non-public URLs, so omit it in local dev and
    reconcile via the return-poll / reconcile job instead."""
    body: dict[str, Any] = {
        "amount": _amount(amount_eur),
        "customerId": customer_id,
        "sequenceType": "first",
        "description": description,
        "redirectUrl": redirect_url,
    }
    if webhook_url:
        body["webhookUrl"] = webhook_url
    if metadata:
        body["metadata"] = metadata
    return await _request("POST", "/payments", json=body)


async def create_recurring_payment(
    *,
    customer_id: str,
    amount_eur: float,
    description: str,
    mandate_id: Optional[str] = None,
    webhook_url: Optional[str] = None,
    metadata: Optional[dict] = None,
) -> dict:
    """Charge a one-off payment off-session against the customer's stored mandate
    (sequenceType='recurring'). No checkout — used for mid-cycle seat proration.
    If `mandate_id` is omitted Mollie uses the customer's most recent valid
    mandate."""
    body: dict[str, Any] = {
        "amount": _amount(amount_eur),
        "customerId": customer_id,
        "sequenceType": "recurring",
        "description": description,
    }
    if mandate_id:
        body["mandateId"] = mandate_id
    if webhook_url:
        body["webhookUrl"] = webhook_url
    if metadata:
        body["metadata"] = metadata
    return await _request("POST", "/payments", json=body)


async def get_payment(payment_id: str) -> dict:
    """Fetch a payment. Always re-fetch on webhook — never trust the payload."""
    return await _request("GET", f"/payments/{payment_id}")


async def list_customer_payments(
    customer_id: str, *, limit: int = 50, from_id: Optional[str] = None
) -> list[dict]:
    """A customer's payments, newest first. Used by the return-sync / reconcile
    path when a webhook was missed (or no public webhook in dev), and by the
    in-app invoice list. `from_id` is a payment id cursor for pagination."""
    path = f"/customers/{customer_id}/payments?limit={limit}"
    if from_id:
        path += f"&from={from_id}"
    data = await _request("GET", path)
    return ((data or {}).get("_embedded") or {}).get("payments") or []


def checkout_url(payment: dict) -> Optional[str]:
    return (((payment or {}).get("_links") or {}).get("checkout") or {}).get("href")


# ── Mandates (payment method) ────────────────────────────────────────


async def list_mandates(customer_id: str) -> list[dict]:
    """A customer's mandates (their stored payment methods). The newest valid
    one is what recurring charges use."""
    data = await _request("GET", f"/customers/{customer_id}/mandates")
    return ((data or {}).get("_embedded") or {}).get("mandates") or []


async def revoke_mandate(customer_id: str, mandate_id: str) -> None:
    """Revoke a stored mandate (DELETE /customers/{id}/mandates/{mid}).

    Used after a customer captures a new payment method, to drop the stale
    one. Safe only because our subscription never pins a `mandateId`: it rides
    the newest valid mandate, so revoking an old mandate never cancels the
    subscription (ADR 0005 / ISSUE-002 Q2). Returns 204 No Content."""
    await _request("DELETE", f"/customers/{customer_id}/mandates/{mandate_id}")


# ── Subscriptions ────────────────────────────────────────────────────


async def create_subscription(
    *,
    customer_id: str,
    amount_eur: float,
    interval: str,
    description: str,
    start_date: Optional[str] = None,
    webhook_url: Optional[str] = None,
    metadata: Optional[dict] = None,
) -> dict:
    """Create a recurring subscription. `amount` is the full per-interval charge
    (= seats x per-seat price; no quantity field). `interval` like '1 month' or
    '12 months'. `description` must be unique per customer.

    `start_date` (YYYY-MM-DD) defers the FIRST subscription charge. Omitting it
    makes Mollie start today and charge immediately — which double-bills when a
    consent payment already covered the first period. Pass one interval out so
    the subscription only charges from the next renewal onward."""
    body: dict[str, Any] = {
        "amount": _amount(amount_eur),
        "interval": interval,
        "description": description,
    }
    if start_date:
        body["startDate"] = start_date
    if webhook_url:
        body["webhookUrl"] = webhook_url
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


async def get_subscription(*, customer_id: str, subscription_id: str) -> dict:
    """Fetch a subscription. `nextPaymentDate` is the end of the current paid
    period — what we use to set the local tier expiry on cancel."""
    return await _request(
        "GET", f"/customers/{customer_id}/subscriptions/{subscription_id}"
    )


async def cancel_subscription(*, customer_id: str, subscription_id: str) -> dict:
    return await _request("DELETE", f"/customers/{customer_id}/subscriptions/{subscription_id}")


# ── Payment links (offline / managed invoicing) ──────────────────────


async def create_payment_link(
    *,
    amount_eur: float,
    description: str,
    webhook_url: Optional[str] = None,
    redirect_url: Optional[str] = None,
    metadata: Optional[dict] = None,
) -> dict:
    """Create a Mollie payment link for an offline / managed invoice (ISSUE-006,
    C2). The buyer opens `_links.paymentLink.href` and pays however they like
    (bank transfer is supported on the hosted page). Mollie still fires our
    webhook when the link is paid, so the existing reconcile path activates the
    account. No mandate or subscription is involved."""
    body: dict[str, Any] = {
        "amount": _amount(amount_eur),
        "description": description,
    }
    if webhook_url:
        body["webhookUrl"] = webhook_url
    if redirect_url:
        body["redirectUrl"] = redirect_url
    if metadata:
        body["metadata"] = metadata
    return await _request("POST", "/payment-links", json=body)


def payment_link_url(link: dict) -> Optional[str]:
    return (((link or {}).get("_links") or {}).get("paymentLink") or {}).get("href")


# ── Sales Invoices (beta REST — the MCP does not expose this) ─────────


async def create_sales_invoice(
    *,
    status: str,
    currency: str = "EUR",
    recipient: Optional[dict] = None,
    lines: Optional[list[dict]] = None,
    payment_term: Optional[str] = None,
    payment_details: Optional[dict] = None,
    email_details: Optional[dict] = None,
    vat_mode: Optional[str] = None,
    vat_scheme: Optional[str] = None,
    is_einvoice: bool = False,
    memo: Optional[str] = None,
    metadata: Optional[dict] = None,
) -> dict:
    """Create a Mollie Sales Invoice (POST /v2/sales-invoices). The Sales
    Invoices API is in beta and the Mollie MCP does not surface it, so this is a
    direct REST call (ISSUE-004).

    - status='issued' -> Mollie auto-assigns the sequential invoice number; we
      don't own the numbering scheme.
    - status='paid' -> set manually with `payment_details` (fits managed mode:
      the buyer paid out-of-band, we just record it). Mollie still numbers it.
    - `is_einvoice=True` toggles the e-invoice flag (ISSUE-005 Q5).

    The resulting PDF lives at `_links.pdfLink.href` (see `get_sales_invoice`)."""
    body: dict[str, Any] = {"status": status, "currency": currency}
    if recipient:
        body["recipient"] = recipient
    if lines is not None:
        body["lines"] = lines
    if payment_term:
        body["paymentTerm"] = payment_term
    if payment_details:
        body["paymentDetails"] = payment_details
    if email_details:
        body["emailDetails"] = email_details
    if vat_mode:
        body["vatMode"] = vat_mode
    if vat_scheme:
        body["vatScheme"] = vat_scheme
    if is_einvoice:
        body["isEInvoice"] = True
    if memo:
        body["memo"] = memo
    if metadata:
        body["metadata"] = metadata
    return await _request("POST", "/sales-invoices", json=body)


async def get_sales_invoice(invoice_id: str) -> dict:
    """Fetch a sales invoice. The downloadable PDF is at
    `_links.pdfLink.href` (locale-aware, set by Mollie)."""
    return await _request("GET", f"/sales-invoices/{invoice_id}")


def sales_invoice_pdf_url(invoice: dict) -> Optional[str]:
    return (((invoice or {}).get("_links") or {}).get("pdfLink") or {}).get("href")
