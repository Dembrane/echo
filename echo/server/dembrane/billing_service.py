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
from dembrane.tier_capacity import (
    PURCHASABLE_TIERS,
    get_capacity,
    compute_monthly_billing_price,
)
from dembrane.directus_async import async_directus

logger = logging.getLogger("billing_service")


class BillingError(RuntimeError):
    pass


def apply_discount(amount: float, percent_discount: int | None) -> float:
    """Reduce `amount` by `percent_discount` (0..100), rounded to cents.

    The single source of truth for "a discount lowers a price". Used for the
    live Mollie charge, the prorated one-off, every customer-facing figure, and
    the admin forecast — so the amount displayed always equals the amount Mollie
    charges (seat-integrity invariant). A null/zero/out-of-range discount is a
    no-op; 100% floors to 0."""
    if not percent_discount:
        return round(amount, 2)
    pct = max(0, min(int(percent_discount), 100))
    return round(amount * (1 - pct / 100), 2)


async def count_account_seats(account_id: str) -> int:
    """Total billable seats across every workspace the account covers.

    Pooled-seat model (ADR 0005): a seat is a *distinct user* under the account,
    not a per-workspace membership. Someone who is an active member of three
    workspaces on the same account is one billable seat, not three. So a user
    who already has a seat anywhere under the account adding/creating another
    workspace is €0 net-new. We dedupe user ids across every workspace before
    counting."""
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
    seat_users: set[str] = set()
    for ws in workspaces:
        users = await _seat_user_ids(ws["id"])
        seat_users.update(users)
    return len(seat_users)


async def _seat_user_ids(workspace_id: str) -> set[str]:
    """Distinct user ids occupying a seat on one workspace (direct members +
    externals; derived oversight access doesn't count). Mirrors
    compute_effective_seat_state's counting rule but returns the ids so the
    account can pool them across workspaces."""
    from dembrane.inheritance import get_effective_members
    from dembrane.seat_capacity import _SEAT_ROLES

    members = await get_effective_members(workspace_id)
    seat_users: set[str] = set()
    for m in members:
        if m.get("source") != "direct":
            continue
        uid = m.get("user_id")
        if not uid:
            continue
        if (m.get("role") or "") in _SEAT_ROLES:
            seat_users.add(uid)
    return seat_users


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
    return f"{label} plan. {seat_txt}, {cadence}, {renews}. Cancel anytime."


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
        return f"SEPA Direct Debit, account ending {tail}" if tail else "SEPA Direct Debit"
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
    percent_discount = account.get("percent_discount")

    # Projected monthly total at the current tier + cadence, net of any account
    # discount. per_seat is shown at sticker (the "before discount" rate); the
    # projected total carries the discount so it matches the actual charge.
    projected_monthly_eur: float | None = None
    per_seat_monthly_eur: float | None = None
    cap = get_capacity(tier)
    if cap is not None and cap.price_eur_monthly is not None:
        per_seat_monthly_eur = (
            compute_monthly_billing_price(cap.price_eur_monthly)
            if billing_period == "monthly"
            else cap.price_eur_monthly
        )
        projected_monthly_eur = apply_discount(per_seat_monthly_eur * seats, percent_discount)

    # Next invoice + payment method come from Mollie (best-effort).
    next_invoice = None
    payment_method = None
    if customer_id and sub_id:
        try:
            sub = await mollie.get_subscription(customer_id=customer_id, subscription_id=sub_id)
            amt = sub.get("amount") or {}
            # Amount reflects the LIVE seat count, not Mollie's stored value. The
            # subscription re-price (sync_subscription_seats) can lag a seat change
            # by up to the cron interval, and a stale figure here reads as a bug
            # ("2 seats but next invoice still shows 900"). projected_monthly_eur is
            # already computed live, so this keeps the two consistent. Date and
            # currency still come from Mollie.
            try:
                renewal_eur, _interval = _per_interval_amount(
                    tier, seats, billing_period, percent_discount
                )
                amount_value = f"{renewal_eur:.2f}"
            except BillingError:
                amount_value = amt.get("value")
            next_invoice = {
                "date": sub.get("nextPaymentDate"),
                "amount": amount_value,
                "currency": amt.get("currency") or "EUR",
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
        # When the plan is winding down (status=="canceled") this is the date
        # access ends and the account drops to Free. Null while renewing.
        "current_period_end": account.get("tier_expires_at"),
        "next_invoice": next_invoice,
        "projected_monthly_eur": projected_monthly_eur,
        "per_seat_monthly_eur": per_seat_monthly_eur,
        "payment_method": payment_method,
        # Surfaced so the customer sees the discount that's already baked into
        # projected_monthly_eur + next_invoice (not a second deduction).
        "percent_discount": percent_discount or None,
        "type_discount": account.get("type_discount"),
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


def _per_interval_amount(
    tier: str, seats: int, billing_period: str, percent_discount: int | None = None
) -> tuple[float, str]:
    """(amount_eur, interval) for the subscription, net of any account discount.

    Annual bills 12x the annual per-seat rate once a year; monthly bills the
    +20% rate each month. `percent_discount` reduces the amount by
    `(1 - percent_discount/100)` so the figure here is exactly what Mollie
    charges and what we display (seat-integrity invariant). Pass the account's
    `percent_discount`; None/0 is full price."""
    cap = get_capacity(tier)
    if cap is None or cap.price_eur_monthly is None:
        raise BillingError(f"tier {tier} is not payable")
    seats = max(seats, 1)
    if billing_period == "monthly":
        per_seat = compute_monthly_billing_price(cap.price_eur_monthly)
        return apply_discount(per_seat * seats, percent_discount), "1 month"
    # annual: pay 12 months of the annual per-seat rate, once per year
    return apply_discount(cap.price_eur_monthly * 12 * seats, percent_discount), "12 months"


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
    # Coming-soon tiers carry a price but can't be bought yet. The frontend hides
    # the button; this is the server-side backstop so a crafted request can't
    # check out a tier we haven't shipped.
    if tier not in PURCHASABLE_TIERS:
        raise BillingError(f"tier {tier} is not available for checkout")
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
    amount, interval = _per_interval_amount(
        tier, seats, billing_period, account.get("percent_discount")
    )

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
        amount, _interval = _per_interval_amount(
            tier, seats, billing_period, account.get("percent_discount")
        )
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


# Approximate period length for proration. Proration is an estimate, so a fixed
# day count avoids month-arithmetic edge cases (leap days, short months).
_PERIOD_DAYS = {"monthly": 30, "annual": 365}


def account_blocks_seat_add(account: dict | None) -> str | None:
    """Reason a seat may NOT be added on this account's billing status, or None
    to allow. Seats can only be added on an active plan: a canceled or past_due
    account must reactivate first (per-seat billing, ADR 0005). A None account
    (free / never subscribed) is not blocked here — the Free seat cap handles
    that and prompts an upgrade."""
    if account is None:
        return None
    if account.get("status") == "active":
        return None
    if account.get("status") in ("canceled", "past_due"):
        return "reactivate_required"
    # pending / none / unknown: leave to the seat-cap + checkout flow.
    return None


async def get_account_for_workspace(workspace_id: str) -> dict | None:
    """The billing_account a workspace bills through, or None if unbilled."""
    ws = await async_directus.get_item("workspace", workspace_id)
    account_id = (ws or {}).get("billing_account_id")
    if not account_id:
        return None
    return await async_directus.get_item("billing_account", account_id)


async def _period_fraction_remaining(account: dict) -> float:
    """Fraction (0..1] of the current billing period still ahead, for prorating a
    mid-cycle seat addition. Returns 0.0 (no proration) when the period end can't
    be read."""
    customer_id = account.get("mollie_customer_id")
    sub_id = account.get("mollie_subscription_id")
    billing_period = account.get("billing_period") or "annual"
    period_days = _PERIOD_DAYS.get(billing_period, 365)
    if not customer_id or not sub_id:
        return 0.0
    try:
        sub = await mollie.get_subscription(customer_id=customer_id, subscription_id=sub_id)
    except mollie.MollieError:
        return 0.0
    next_date_str = sub.get("nextPaymentDate")  # "YYYY-MM-DD"
    if not next_date_str:
        return 0.0
    try:
        next_date = datetime.fromisoformat(next_date_str)
    except ValueError:
        return 0.0
    if next_date.tzinfo is None:
        next_date = next_date.replace(tzinfo=timezone.utc)
    # Whole-calendar-day granularity (not a raw timedelta). The pre-invite estimate
    # and the actual charge call this at different sub-second moments; counting by
    # calendar day makes them agree as long as they happen on the same day, so the
    # preview ("897") matches the charge ("900") instead of drifting by the hours
    # elapsed between them.
    days_remaining = (next_date.date() - datetime.now(timezone.utc).date()).days
    if days_remaining <= 0:
        return 0.0
    return min(days_remaining / period_days, 1.0)


async def _charge_seat_proration(account: dict, added_seats: int) -> float | None:
    """One-off prorated charge for `added_seats` added mid-cycle, off-session
    against the stored mandate. The caller has verified the account is active on
    a paid tier with a subscription. Returns the amount charged, else None."""
    if added_seats < 1:
        return None
    tier = account.get("tier")
    customer_id = account.get("mollie_customer_id")
    account_id = account.get("id")
    billing_period = account.get("billing_period") or "annual"

    fraction = await _period_fraction_remaining(account)
    if fraction <= 0:
        return None
    try:
        full_added, _interval = _per_interval_amount(
            tier, added_seats, billing_period, account.get("percent_discount")
        )
    except BillingError:
        return None
    prorated = round(full_added * fraction, 2)
    if prorated < 0.01:
        return None

    try:
        mandates = await mollie.list_mandates(customer_id)
    except mollie.MollieError:
        mandates = []
    valid = next((m for m in mandates if m.get("status") == "valid"), None)
    if not valid:
        logger.warning(
            "No valid mandate on account %s; skipping the proration charge", account_id
        )
        return None

    try:
        await mollie.create_recurring_payment(
            customer_id=customer_id,
            amount_eur=prorated,
            description=f"{added_seats} seat(s) added, prorated for the rest of this period",
            mandate_id=valid.get("id"),
            metadata={
                "account_id": account_id,
                "kind": "seat_proration",
                "added_seats": str(added_seats),
            },
        )
    except mollie.MollieError as exc:
        logger.error("Proration charge failed for account %s: %s", account_id, exc)
        return None

    logger.info(
        "charged %.2f EUR proration for %d seat(s) on account %s",
        prorated,
        added_seats,
        account_id,
    )
    return prorated


async def reconcile_account_seats(account_id: str) -> None:
    """Bring billing in line with the live seat count for one account. Idempotent
    and safe to call from both the seat-change endpoints and the periodic cron.

    - Re-prices the recurring subscription so the NEXT renewal matches current
      seats (both up and down).
    - On a net INCREASE, charges a one-off prorated payment for the added seats
      covering the days left in the current period.
    - On a DECREASE, only the next renewal drops (no mid-cycle refund).

    `provisioned_seats` records the count already charged for, so re-running never
    double-charges. No-op unless the account is active on a paid tier with a
    Mollie subscription."""
    account = await async_directus.get_item("billing_account", account_id)
    if not account or account.get("status") != "active":
        return
    tier = account.get("tier")
    if not tier or tier == "free" or not account.get("mollie_subscription_id"):
        return

    # The next renewal always reflects the live seat count.
    await sync_subscription_seats(account_id)

    current = max(await count_account_seats(account_id), 1)
    provisioned = account.get("provisioned_seats")

    # First reconcile for this account: set the baseline, never charge for seats
    # that predate proration tracking.
    if provisioned is None:
        await async_directus.update_item(
            "billing_account", account_id, {"provisioned_seats": current}
        )
        return

    if current > provisioned:
        charged = await _charge_seat_proration(account, current - provisioned)
        # Only advance the baseline once the charge lands, so a failed charge
        # (e.g. dead mandate) retries on the next reconcile rather than being lost.
        if charged is not None:
            await async_directus.update_item(
                "billing_account", account_id, {"provisioned_seats": current}
            )
    elif current < provisioned:
        # Removal takes effect at renewal (re-priced above); no mid-cycle refund.
        await async_directus.update_item(
            "billing_account", account_id, {"provisioned_seats": current}
        )


async def estimate_seat_addition(account_id: str, added_seats: int = 1) -> dict:
    """Preview the cost of adding `added_seats`, for the invite confirm dialog:
    the one-off prorated charge now plus how much the recurring renewal goes up.
    `active` is False when there's nothing to charge (free / not subscribed), and
    the UI shows no charge (or the reactivate gate) in that case."""
    account = await async_directus.get_item("billing_account", account_id)
    billing_period = (account or {}).get("billing_period") or "annual"
    result = {
        "active": False,
        "added_seats": added_seats,
        "billing_period": billing_period,
        "currency": "EUR",
        "prorated_now_eur": 0.0,
        "recurring_delta_eur": 0.0,
    }
    if not account or account.get("status") != "active":
        return result
    tier = account.get("tier")
    if not tier or tier == "free" or not account.get("mollie_subscription_id"):
        return result
    try:
        full_added, _interval = _per_interval_amount(
            tier, added_seats, billing_period, account.get("percent_discount")
        )
    except BillingError:
        return result
    fraction = await _period_fraction_remaining(account)
    result["active"] = True
    result["recurring_delta_eur"] = round(full_added, 2)
    result["prorated_now_eur"] = round(full_added * fraction, 2)
    return result


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
