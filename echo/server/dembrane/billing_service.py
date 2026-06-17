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
from datetime import datetime, timezone, timedelta

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


def _plan_description(tier: str, seats: int, billing_period: str) -> str:
    """Customer-facing line shown on the Mollie checkout + each charge.

    Mollie's hosted page shows this verbatim, so it has to read like a real
    receipt, not a code string: capitalised plan, seat count, cadence, and the
    cancel-anytime reassurance. Keeps the page from feeling sketchy.
    """
    label = tier.capitalize()
    seat_txt = f"{seats} seat" + ("s" if seats != 1 else "")
    cadence = "billed monthly" if billing_period == "monthly" else "billed yearly"
    renews = "renews monthly" if billing_period == "monthly" else "renews yearly"
    return f"dembrane {label} plan. {seat_txt}, {cadence}, {renews}. Cancel anytime."


async def list_account_invoices(
    account_id: str, *, limit: int = 20, from_id: str | None = None
) -> dict:
    """Paginated payment history for the account's Mollie customer, newest first.

    Mollie has no customer-facing portal, so this is the in-app invoice list:
    each consent + recurring charge, with date / amount / status. Returns
    {"invoices": [...], "next": <cursor or None>}. `next` is the payment-id
    cursor for "load more"; None when there are no more."""
    account = await async_directus.get_item("billing_account", account_id)
    customer_id = (account or {}).get("mollie_customer_id")
    if not customer_id:
        return {"invoices": [], "next": None}
    # Fetch one extra to know whether there's a next page.
    payments = await mollie.list_customer_payments(
        customer_id, limit=limit + 1, from_id=from_id
    )
    next_cursor = payments[limit]["id"] if len(payments) > limit else None
    out: list[dict] = []
    for p in payments[:limit]:
        amt = p.get("amount") or {}
        out.append(
            {
                "id": p.get("id"),
                "created_at": p.get("createdAt"),
                "amount": amt.get("value"),
                "currency": amt.get("currency"),
                "status": p.get("status"),
                "description": p.get("description") or "",
            }
        )
    return {"invoices": out, "next": next_cursor}


def _payment_method_label(mandate: dict) -> str:
    """Human label for a Mollie mandate, e.g. 'Card ending 1234' / 'SEPA Direct Debit'."""
    method = mandate.get("method")
    details = mandate.get("details") or {}
    if method == "creditcard":
        last4 = details.get("cardNumber") or details.get("cardLabel")
        return f"Card ending {last4}" if last4 else "Card"
    if method == "directdebit":
        acct = details.get("consumerAccount")
        tail = acct[-4:] if acct else None
        return f"SEPA Direct Debit ({tail})" if tail else "SEPA Direct Debit"
    return method or "Unknown"


async def get_billing_overview(account_id: str) -> dict:
    """Everything the billing dashboard needs in one call: plan, seats, next
    invoice, projected monthly total, and the current payment method."""
    account = await async_directus.get_item("billing_account", account_id)
    if not account:
        return {}
    tier = account.get("tier") or "free"
    billing_period = account.get("billing_period") or "annual"
    status = account.get("status")
    seats = max(await count_account_seats(account_id), 1)
    customer_id = account.get("mollie_customer_id")
    sub_id = account.get("mollie_subscription_id")

    # Projected monthly total at the current tier + cadence.
    projected_monthly_eur: float | None = None
    per_seat_monthly_eur: float | None = None
    cap = get_capacity(tier)
    if cap is not None and cap.price_eur_monthly is not None:
        per_seat_monthly_eur = (
            compute_monthly_billing_price(cap.price_eur_monthly)
            if billing_period == "monthly"
            else cap.price_eur_monthly
        )
        projected_monthly_eur = round(per_seat_monthly_eur * seats, 2)

    # Next invoice + payment method come from Mollie (best-effort).
    next_invoice = None
    payment_method = None
    if customer_id and sub_id:
        try:
            sub = await mollie.get_subscription(customer_id=customer_id, subscription_id=sub_id)
            amt = sub.get("amount") or {}
            next_invoice = {
                "date": sub.get("nextPaymentDate"),
                "amount": amt.get("value"),
                "currency": amt.get("currency"),
            }
        except mollie.MollieError:
            pass
    if customer_id:
        try:
            mandates = await mollie.list_mandates(customer_id)
            valid = next((m for m in mandates if m.get("status") == "valid"), None) or (
                mandates[0] if mandates else None
            )
            if valid:
                payment_method = {
                    "type": valid.get("method"),
                    "label": _payment_method_label(valid),
                }
        except mollie.MollieError:
            pass

    return {
        "tier": tier,
        "status": status,
        "billing_period": billing_period,
        "seats": seats,
        "next_invoice": next_invoice,
        "projected_monthly_eur": projected_monthly_eur,
        "per_seat_monthly_eur": per_seat_monthly_eur,
        "payment_method": payment_method,
    }


async def estimate_account_cost(account_id: str) -> dict:
    """What each payable tier would cost the account at its current seat count.

    Powers the "cost to move" preview before someone upgrades. Per-seat figures
    plus the rolled-up totals for both cadences, so the UI can show "Xeur/mo per
    seat, Yeur/yr for your N seats" without re-deriving the math."""
    seats = max(await count_account_seats(account_id), 1)
    tiers: dict[str, dict] = {}
    for tier in ("innovator", "changemaker", "guardian"):
        cap = get_capacity(tier)
        if cap is None or cap.price_eur_monthly is None:
            continue
        annual_per_seat = cap.price_eur_monthly  # annual-billing monthly per-seat rate
        monthly_per_seat = compute_monthly_billing_price(annual_per_seat)
        tiers[tier] = {
            "annual_per_seat_monthly": annual_per_seat,
            "monthly_per_seat": monthly_per_seat,
            "annual_total_yearly": annual_per_seat * 12 * seats,
            "monthly_total_monthly": monthly_per_seat * seats,
        }
    return {"seats": seats, "tiers": tiers}


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
    if not webhook_url:
        logger.warning(
            "MOLLIE_WEBHOOK_URL is not set — Mollie cannot push payment updates; "
            "relying on /sync (return-poll / reconcile). Fine for local; set it in "
            "deployed environments for push activation."
        )

    account = await async_directus.get_item("billing_account", account_id)
    if not account:
        raise BillingError("billing account not found")

    seats = await count_account_seats(account_id)
    amount, interval = _per_interval_amount(tier, seats, billing_period)

    customer_id = await _ensure_customer(account)
    payment = await mollie.create_first_payment(
        customer_id=customer_id,
        amount_eur=amount,
        description=_plan_description(tier, seats, billing_period),
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
    seats = int(meta.get("seats") or 1)
    billing_period = meta.get("billing_period") or "annual"
    sub = await mollie.create_subscription(
        customer_id=customer_id,
        amount_eur=amount,
        interval=interval,
        description=_plan_description(tier, seats, billing_period),
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


async def sync_account_from_mollie(account_id: str) -> str:
    """Reconcile an account's status from Mollie (return-poll / missed-webhook /
    scheduled catch-up). If a consent 'first' payment has cleared and no
    subscription exists yet, activate. Returns the resulting status.

    Safe to call repeatedly — activation is idempotent.
    """
    account = await async_directus.get_item("billing_account", account_id)
    if not account:
        return "none"
    customer_id = account.get("mollie_customer_id")
    if not customer_id:
        return account.get("status") or "none"
    if account.get("mollie_subscription_id"):
        return account.get("status") or "active"

    payments = await mollie.list_customer_payments(customer_id)
    first_paid = next(
        (
            p
            for p in payments
            if p.get("sequenceType") == "first"
            and p.get("status") == "paid"
            and (p.get("metadata") or {}).get("billing_account_id") == account_id
        ),
        None,
    )
    if first_paid:
        await _activate_from_first_payment(account_id, first_paid.get("metadata") or {}, customer_id)
        return "active"
    return account.get("status") or "pending"


def _period_end_iso(billing_period: str | None) -> str:
    """Fallback period end from now (when Mollie can't give us nextPaymentDate)."""
    days = 365 if billing_period == "annual" else 30
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()


async def sync_subscription_seats(account_id: str) -> float | None:
    """Re-price an active subscription to match the account's current seat count.

    Per-seat billing with no Mollie quantity field, so a seat change means
    PATCHing the subscription's flat amount (= seats x per-seat price for the
    account's tier + cadence). No-op unless the account is active with a Mollie
    subscription, and skips the PATCH when the amount already matches. The new
    amount applies to the next charge. Returns the amount it set, or None."""
    account = await async_directus.get_item("billing_account", account_id)
    if not account or account.get("status") != "active":
        return None
    sub_id = account.get("mollie_subscription_id")
    customer_id = account.get("mollie_customer_id")
    tier = account.get("tier")
    if not sub_id or not customer_id or not tier or tier == "free":
        return None
    billing_period = account.get("billing_period") or "annual"
    seats = max(await count_account_seats(account_id), 1)
    try:
        amount, _interval = _per_interval_amount(tier, seats, billing_period)
    except BillingError:
        return None

    # Skip the PATCH when nothing changed (cron runs often; Mollie calls aren't free).
    try:
        sub = await mollie.get_subscription(customer_id=customer_id, subscription_id=sub_id)
        current = float((sub.get("amount") or {}).get("value") or 0)
    except (mollie.MollieError, ValueError):
        current = None
    if current is not None and abs(current - amount) < 0.01:
        return amount

    await mollie.update_subscription_amount(
        customer_id=customer_id, subscription_id=sub_id, amount_eur=amount
    )
    logger.info(
        "re-priced sub %s to %s EUR for %d seat(s) on account %s",
        sub_id,
        amount,
        seats,
        account_id,
    )
    return amount


async def cancel_subscription(
    account_id: str, *, reason: str | None = None, feedback: str | None = None
) -> str:
    """Stop the account's subscription from renewing, keeping the paid tier
    until the end of the current period.

    We cancel the Mollie subscription (no more charges) but the customer keeps
    what they paid for: the tier stays and `tier_expires_at` is set to the end
    of the current period. The existing tier-expiry cron reverts to Free when it
    lapses. The churn reason is logged for the team (the client also emits a
    PostHog event). Idempotent. Returns the resulting status ('canceled', or
    'free' if there was nothing to cancel)."""
    account = await async_directus.get_item("billing_account", account_id)
    if not account:
        raise BillingError("billing account not found")

    sub_id = account.get("mollie_subscription_id")
    customer_id = account.get("mollie_customer_id")
    if not sub_id or not customer_id:
        # Nothing to cancel (e.g. a comped trial or never-subscribed account).
        return account.get("status") or "free"

    # Read the period end before cancelling — Mollie clears it on cancel.
    period_end: str | None = None
    try:
        sub = await mollie.get_subscription(customer_id=customer_id, subscription_id=sub_id)
        next_date = sub.get("nextPaymentDate")  # "YYYY-MM-DD"
        if next_date:
            period_end = f"{next_date}T00:00:00+00:00"
    except mollie.MollieError as exc:
        logger.warning("Could not read Mollie sub %s before cancel: %s", sub_id, exc)

    try:
        await mollie.cancel_subscription(customer_id=customer_id, subscription_id=sub_id)
    except mollie.MollieError as exc:
        # 404/410 means it's already gone — proceed to wind down locally.
        logger.warning("Mollie cancel for sub %s returned %s; winding down locally", sub_id, exc)

    expires_at = period_end or _period_end_iso(account.get("billing_period"))
    logger.info(
        "billing account %s cancelled, tier kept until %s (reason=%r feedback=%r)",
        account_id,
        expires_at,
        reason,
        feedback,
    )
    await async_directus.update_item(
        "billing_account",
        account_id,
        {
            # Keep tier + billing_period: they paid for this period.
            "status": "canceled",
            "payment_mode": "none",
            "mollie_subscription_id": None,
            "tier_expires_at": expires_at,
            "pre_warning_sent": False,
        },
    )
    return "canceled"


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
