"""Billing orchestration: ties Mollie (customer/subscription) to billing_account.

The domain logic sits here so `mollie.py` stays pure transport and
`billing_account.py` stays pure data helpers. Flow (ADR 0005 + the self-serve
plan):

  start_subscription_checkout -> ensure a Mollie customer for the account, create
  a consent ('first') payment for the first charge, return the hosted checkout
  URL. The customer pays once.

  handle_mollie_webhook -> Mollie calls us per payment. We re-fetch the payment
  (never trust the payload), read our metadata, and:
    - first payment paid  -> create the recurring subscription, activate the
      account (tier + status=active, payment_mode=mollie, clear trial expiry).
    - recurring payment paid/failed -> account status active / past_due.

Amount is per seat: `seats x per-seat price`. Mollie has no quantity, so a seat
change later means PATCHing the subscription amount.
"""

from __future__ import annotations

import logging

from dembrane import mollie
from dembrane.settings import get_settings
from dembrane.seat_capacity import compute_effective_seat_state
from dembrane.tier_capacity import get_capacity, compute_monthly_billing_price
from dembrane.directus_async import async_directus

logger = logging.getLogger("billing_service")


class BillingError(RuntimeError):
    pass


async def count_account_seats(account_id: str) -> int:
    """Total billable seats across every workspace the account covers."""
    workspaces = await async_directus.get_items(
        "workspace",
        {
            "query": {
                "filter": {
                    "billing_account_id": {"_eq": account_id},
                    "deleted_at": {"_null": True},
                },
                "fields": ["id"],
                "limit": -1,
            }
        },
    )
    if not isinstance(workspaces, list):
        return 0
    total = 0
    for ws in workspaces:
        seats_used, _m, _e = await compute_effective_seat_state(ws["id"])
        total += seats_used
    return total


def _per_interval_amount(tier: str, seats: int, billing_period: str) -> tuple[float, str]:
    """(amount_eur, interval) for the subscription. Annual bills 12x the annual
    per-seat rate once a year; monthly bills the +20% rate each month."""
    cap = get_capacity(tier)
    if cap is None or cap.price_eur_monthly is None:
        raise BillingError(f"tier {tier} is not payable")
    seats = max(seats, 1)
    if billing_period == "monthly":
        per_seat = compute_monthly_billing_price(cap.price_eur_monthly)
        return round(per_seat * seats, 2), "1 month"
    # annual: pay 12 months of the annual per-seat rate, once per year
    return round(cap.price_eur_monthly * 12 * seats, 2), "12 months"


async def _billing_contact(account: dict) -> tuple[str, str]:
    """(name, email) for the Mollie customer — the account label + the
    creator's email, with safe fallbacks."""
    name = account.get("label") or "dembrane customer"
    email = "billing@dembrane.com"
    creator = account.get("created_by")
    if creator:
        user = await async_directus.get_item("app_user", creator)
        if user and user.get("email"):
            email = user["email"]
    return name, email


async def _ensure_customer(account: dict) -> str:
    if account.get("mollie_customer_id"):
        return account["mollie_customer_id"]
    name, email = await _billing_contact(account)
    customer = await mollie.create_customer(
        name=name, email=email, metadata={"billing_account_id": account["id"]}
    )
    cust_id = customer["id"]
    await async_directus.update_item(
        "billing_account", account["id"], {"mollie_customer_id": cust_id}
    )
    return cust_id


async def start_subscription_checkout(
    account_id: str,
    *,
    tier: str,
    billing_period: str = "annual",
    redirect_url: str,
) -> str:
    """Ensure a customer + create the consent payment; return the checkout URL.
    The subscription itself is created when the first payment's webhook confirms.
    """
    settings = get_settings()
    if not settings.billing.mollie_enabled:
        raise BillingError("Mollie is not configured")
    # webhook_url is optional: Mollie rejects non-public URLs, so in dev we omit
    # it and reconcile via the return-poll / reconcile job.
    webhook_url = settings.billing.mollie_webhook_url

    account = await async_directus.get_item("billing_account", account_id)
    if not account:
        raise BillingError("billing account not found")

    seats = await count_account_seats(account_id)
    amount, interval = _per_interval_amount(tier, seats, billing_period)

    customer_id = await _ensure_customer(account)
    payment = await mollie.create_first_payment(
        customer_id=customer_id,
        amount_eur=amount,
        description=f"dembrane {tier} ({seats} seat{'s' if seats != 1 else ''})",
        redirect_url=redirect_url,
        webhook_url=webhook_url,
        metadata={
            "billing_account_id": account_id,
            "intent": "activate",
            "tier": tier,
            "billing_period": billing_period,
            "interval": interval,
            "seats": seats,
            "amount_eur": amount,
        },
    )
    await async_directus.update_item("billing_account", account_id, {"status": "pending"})
    url = mollie.checkout_url(payment)
    if not url:
        raise BillingError("Mollie did not return a checkout URL")
    return url


async def _activate_from_first_payment(account_id: str, meta: dict, customer_id: str) -> None:
    """First consent payment cleared: create the recurring subscription and
    activate the account."""
    account = await async_directus.get_item("billing_account", account_id)
    if not account:
        return
    if account.get("mollie_subscription_id"):
        return  # idempotent — subscription already created
    settings = get_settings()
    tier = meta.get("tier") or account.get("tier")
    interval = meta.get("interval") or "12 months"
    amount = float(meta.get("amount_eur") or 0)
    sub = await mollie.create_subscription(
        customer_id=customer_id,
        amount_eur=amount,
        interval=interval,
        description=f"dembrane {tier}",
        webhook_url=settings.billing.mollie_webhook_url or "",
        metadata={"billing_account_id": account_id},
    )
    await async_directus.update_item(
        "billing_account",
        account_id,
        {
            "tier": tier,
            "status": "active",
            "payment_mode": "mollie",
            "mollie_subscription_id": sub.get("id"),
            "billing_period": meta.get("billing_period"),
            # Subscription now carries continuity; clear any trial expiry.
            "tier_expires_at": None,
            "type_discount": None,
        },
    )
    logger.info("activated billing account %s on %s via Mollie sub %s", account_id, tier, sub.get("id"))


async def handle_mollie_webhook(payment_id: str) -> None:
    """Process a Mollie payment webhook. Re-fetches the payment (never trusts the
    POST body), then reconciles the billing account. Idempotent."""
    payment = await mollie.get_payment(payment_id)
    meta = payment.get("metadata") or {}
    account_id = meta.get("billing_account_id")
    if not account_id:
        logger.warning("Mollie webhook for %s has no billing_account_id; ignoring", payment_id)
        return
    status = payment.get("status")
    customer_id = payment.get("customerId")
    sequence = payment.get("sequenceType")

    if sequence == "first" and status == "paid":
        if customer_id:
            await _activate_from_first_payment(account_id, meta, customer_id)
        return

    # Recurring payment outcomes.
    if payment.get("subscriptionId"):
        if status == "paid":
            await async_directus.update_item("billing_account", account_id, {"status": "active"})
        elif status in ("failed", "expired", "canceled"):
            await async_directus.update_item("billing_account", account_id, {"status": "past_due"})
        return

    # First payment that did not succeed: leave the account un-activated.
    if sequence == "first" and status in ("failed", "expired", "canceled"):
        await async_directus.update_item("billing_account", account_id, {"status": "none"})
