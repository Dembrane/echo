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

import asyncio
import logging
from uuid import uuid4
from typing import Any
from datetime import datetime, timezone, timedelta

from dembrane import mollie
from dembrane.settings import get_settings
from dembrane.redis_async import get_redis_client
from dembrane.seat_capacity import count_pending_invites
from dembrane.tier_capacity import (
    PURCHASABLE_TIERS,
    get_capacity,
    compute_monthly_billing_price,
)
from dembrane.directus_async import async_directus

logger = logging.getLogger("billing_service")


# Serializes activation for one account across its concurrent triggers (Mollie
# webhook, return-poll /sync, reconcile cron). Without it, two callers both see
# "no subscription yet" and both POST a subscription; Mollie rejects the second
# (unique description) with a noisy 422. Short TTL so a crashed holder can't
# wedge activation. Fail-open if Redis is down — same as the pre-lock behavior.
_ACTIVATION_LOCK_TTL_SECONDS = 30


async def _try_acquire_activation_lock(account_id: str) -> tuple[Any, str | None]:
    """Return (client, token). token is None when another caller holds the lock
    (skip activation) or when Redis is unavailable (proceed without a lock —
    distinguished by client being None)."""
    key = f"dembrane:billing:activation_lock:{account_id}"
    try:
        client = await get_redis_client()
    except Exception:
        logger.warning("Redis unavailable for activation lock on %s; proceeding", account_id)
        return None, None
    token = str(uuid4())
    try:
        acquired = await client.set(key, token, ex=_ACTIVATION_LOCK_TTL_SECONDS, nx=True)
    except Exception:
        logger.warning("Activation lock set failed on %s; proceeding", account_id)
        return None, None
    return (client, token) if acquired else (client, None)


async def _release_activation_lock(account_id: str, client: Any, token: str | None) -> None:
    if client is None or token is None:
        return
    key = f"dembrane:billing:activation_lock:{account_id}"
    script = (
        'if redis.call("get", KEYS[1]) == ARGV[1] then '
        'return redis.call("del", KEYS[1]) else return 0 end'
    )
    try:
        result = client.eval(script, 1, key, token)
        if asyncio.iscoroutine(result):
            await result
    except Exception:
        logger.warning("Failed to release activation lock for %s", account_id, exc_info=True)


def apply_discount(amount: float, percent_discount: int | None) -> float:
    """Apply a billing-account discount to an amount: `amount × (1 - pct/100)`.

    Single source for the discount math so every pricing path (real Mollie
    charges, customer display, admin forecast) reduces by the same rule. The
    percent is clamped to 0..100: a null / out-of-range value is a no-op, 100%
    floors the charge to EUR0. Rounded to cents."""
    if not percent_discount:
        return round(amount, 2)
    pct = max(0, min(100, int(percent_discount)))
    return round(amount * (1 - pct / 100), 2)


class BillingError(RuntimeError):
    pass


class ReconcileChargeError(RuntimeError):
    """A needed mid-cycle proration charge could not be placed against Mollie:
    a dead/invalid mandate or a Mollie API error. Distinct from "nothing to
    charge" so reconcile can flag the account (reconcile_failed_at) without
    advancing the provisioned-seat baseline. Never surfaced to a request: it
    is caught inside reconcile_account_seats."""


def is_managed(account: dict | None) -> bool:
    """A managed ('managed by dembrane') account: `payment_mode == 'offline'`.

    Managed is a payment distinction, not a capability one (ISSUE-021): the plan
    works fully, but every Mollie auto-debit behaviour is off. Dunning,
    pre-warning expiry, failed-charge banners, and reconcile auto-charge all skip
    managed accounts. Staff issues invoices (pay-link / sales invoice) instead.
    Entitlements come from tier + status, never from a successful charge."""
    return bool(account) and (account or {}).get("payment_mode") == "offline"


async def count_account_seats(account_id: str) -> int:
    """Billable seats for the account: the count of DISTINCT users across every
    workspace the account covers, not the per-workspace sum.

    Seats are pooled (ADR 0005): one paying account, one bill, however many
    workspaces. A user who belongs to N of the account's workspaces is one seat,
    not N. Summing each workspace's seat count double-counts them — that is the
    phantom-seat bug where an existing member who creates (and so owns) another
    workspace looked like a brand-new seat. Pooling distinct user ids makes that
    a no-op: the new workspace adds no user the account wasn't already paying
    for, so net-new is 0 and the bill is unchanged."""
    from dembrane.seat_capacity import effective_seat_user_ids

    seat_user_ids: set[str] = set()
    for ws_id in await _account_workspace_ids(account_id):
        seat_user_ids |= await effective_seat_user_ids(ws_id)
    return len(seat_user_ids)


async def _account_workspace_ids(account_id: str) -> list[str]:
    """Live (non-deleted) workspace ids the account covers."""
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
        return []
    return [w["id"] for w in workspaces if w.get("id")]


async def invalidate_account_usage_caches(account_id: str) -> None:
    """Bust the workspace + org usage rollups for every workspace the account
    covers. Tier/status live on the account but the rollups cache a flattened
    per-workspace `tier` (and the seat-cap/needs-attention flags derived from
    it) for USAGE_TTL_SECONDS. Without this, a tier change (e.g. free →
    changemaker on activation) keeps serving the pre-upgrade snapshot — the
    "Needs attention / Upgrade" panel lingers for up to 30 minutes.

    Call after any write that changes `tier` or `status` on a billing account.
    """
    from dembrane.cache_utils import (
        invalidate_org_usage,
        invalidate_workspace_usage,
    )

    account = await async_directus.get_item("billing_account", account_id)
    org_id = (account or {}).get("org_id")
    for ws_id in await _account_workspace_ids(account_id):
        await invalidate_workspace_usage(ws_id)
    if org_id:
        await invalidate_org_usage(org_id)


async def count_account_pending_invites(account_id: str) -> int:
    """Pending (un-accepted, unexpired) workspace invites across the whole
    account. Seats are pooled, so the billing footnote counts pending across
    every workspace the account covers."""
    total = 0
    for ws_id in await _account_workspace_ids(account_id):
        # observer_pending is free and excluded from the billable footnote.
        member_pending, external_pending, _observer_pending = await count_pending_invites(
            ws_id
        )
        total += member_pending + external_pending
    return total


async def account_active_seat_emails(account_id: str) -> set[str]:
    """Lower-cased emails of every active (direct) billable seat-holder across
    the account. Used to dedupe net-new seats in the invite preview: a recipient
    already holding a seat anywhere on the account is not net-new (seats are
    pooled). Free observers never hold a seat, so they are excluded."""
    from dembrane.seat_capacity import effective_seat_user_ids

    emails: set[str] = set()
    for ws_id in await _account_workspace_ids(account_id):
        # effective_seat_user_ids already excludes observers and derived access.
        for uid in await effective_seat_user_ids(ws_id):
            user = await async_directus.get_item("app_user", uid)
            email = (user or {}).get("email")
            if email:
                emails.add(email.strip().lower())
    return emails


async def account_pending_invite_emails(account_id: str) -> set[str]:
    """Lower-cased emails with an active pending paid invite anywhere on the
    account. A recipient already invited counts once toward net-new, not twice.
    Free observer invites never consume a seat, so they are excluded."""
    now_iso = datetime.now(timezone.utc).isoformat()
    emails: set[str] = set()
    for ws_id in await _account_workspace_ids(account_id):
        rows = await async_directus.get_items(
            "workspace_invite",
            {
                "query": {
                    "filter": {
                        "workspace_id": {"_eq": ws_id},
                        "accepted_at": {"_null": True},
                        "deleted_at": {"_null": True},
                        "expires_at": {"_gt": now_iso},
                    },
                    "fields": ["email", "role"],
                    "limit": -1,
                }
            },
        )
        if not isinstance(rows, list):
            continue
        for r in rows:
            # Observer invites are free, so they don't dedupe a net-new paid seat.
            if (r.get("role") or "") == "observer":
                continue
            email = r.get("email")
            if email:
                emails.add(email.strip().lower())
    return emails


async def count_net_new_seats(account_id: str, recipient_emails: list[str]) -> int:
    """Net-new seats for a batch of invite recipients. Excludes recipients who
    already hold an active seat anywhere on the account or already have a pending
    invite (deduped, counted once). Founder rule A1: inviting an existing active
    member under the paying account is EUR0 net-new."""
    cleaned = {e.strip().lower() for e in recipient_emails if e and e.strip()}
    if not cleaned:
        return 0
    already = await account_active_seat_emails(account_id)
    already |= await account_pending_invite_emails(account_id)
    return len(cleaned - already)


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


def _invoice_row(p: dict) -> dict:
    """Shape one Mollie payment into an invoice-ledger row."""
    amt = p.get("amount") or {}
    status = p.get("status")
    # Open/pending charges keep a "Pay now" checkout link; null once settled.
    pay_url = mollie.checkout_url(p) if status in ("open", "pending") else None
    return {
        "id": p.get("id"),
        "created_at": p.get("createdAt"),
        "amount": amt.get("value"),
        "currency": amt.get("currency"),
        "status": status,
        "description": p.get("description") or "",
        "pay_url": pay_url,
    }


def _is_ledger_hidden(p: dict) -> bool:
    """Method-update consents (EUR0 mandate captures) are not invoices and are
    hidden from the ledger (Fix H)."""
    return (p.get("metadata") or {}).get("intent") == "update_payment_method"


# Pull successive pages until enough non-consent rows; cap the scan for safety.
_LEDGER_FETCH = 50
_LEDGER_MAX_FETCHES = 12


async def list_account_invoices(
    account_id: str, *, limit: int = 20, from_id: str | None = None
) -> dict:
    """Paginated payment history for the account's Mollie customer, newest first.

    Mollie has no customer-facing portal, so this is the in-app invoice list:
    each consent + recurring charge, with date / amount / status. Returns
    {"invoices": [...], "next": <cursor or None>}. `next` is the payment-id
    cursor for "load more"; None when there are no more.

    Method-update consents are hidden (Fix H). Filtering one raw page can empty
    it while real invoices sit further back, so we pull successive Mollie pages
    (skipping consents) until we have one more displayable row than the page
    needs — that extra row tells us a next page exists and supplies its cursor —
    or Mollie is exhausted. Mollie's `from` is INCLUSIVE, so a continued fetch
    repeats the previous page's last row; we drop that duplicate."""
    account = await async_directus.get_item("billing_account", account_id)
    customer_id = (account or {}).get("mollie_customer_id")
    if not customer_id:
        return {"invoices": [], "next": None}

    shown: list[dict] = []
    cursor = from_id
    first = True
    for _ in range(_LEDGER_MAX_FETCHES):
        raw = await mollie.list_customer_payments(
            customer_id, limit=_LEDGER_FETCH, from_id=cursor
        )
        if not raw:
            break
        # Inclusive cursor: a continued fetch repeats the cursor row, so drop it.
        window = raw if first else (raw[1:] if raw and raw[0].get("id") == cursor else raw)
        first = False
        for p in window:
            if _is_ledger_hidden(p):
                continue
            shown.append(p)
            if len(shown) > limit:  # one past the page: a next page exists
                break
        if len(shown) > limit or len(raw) < _LEDGER_FETCH:
            break
        cursor = raw[-1].get("id")

    next_cursor = shown[limit].get("id") if len(shown) > limit else None
    invoices = [_invoice_row(p) for p in shown[:limit]]
    return {"invoices": invoices, "next": next_cursor}


async def latest_method_update_status(account_id: str) -> str | None:
    """Mollie status of the most recent 'update payment method' consent, or None
    if the account never started one.

    A method swap doesn't move the account status (it stays active / past_due),
    so the return-from-checkout UI can't tell a successful change from a
    cancelled / failed one by status alone. This reports the real outcome
    ('paid' / 'failed' / 'expired' / 'canceled' / 'open' / 'pending')."""
    account = await async_directus.get_item("billing_account", account_id)
    customer_id = (account or {}).get("mollie_customer_id")
    if not customer_id:
        return None
    payments = await mollie.list_customer_payments(customer_id, limit=_LEDGER_FETCH)
    for p in payments:  # newest first
        if (p.get("metadata") or {}).get("intent") == "update_payment_method":
            return p.get("status")
    return None


async def pending_checkout_url(account_id: str) -> str | None:
    """The hosted checkout URL of an in-flight activation consent, so a customer
    who didn't finish their first payment can resume the exact same Mollie
    checkout instead of being stuck.

    Only meaningful while the account is 'pending' (checkout started, not yet
    activated) and an 'open'/'pending' first payment with intent='activate'
    exists. None otherwise — the caller then shows the plan picker."""
    account = await async_directus.get_item("billing_account", account_id)
    customer_id = (account or {}).get("mollie_customer_id")
    if not customer_id or (account or {}).get("status") != "pending":
        return None
    try:
        payments = await mollie.list_customer_payments(customer_id, limit=_LEDGER_FETCH)
    except mollie.MollieError:
        return None
    for p in payments:  # newest first
        meta = p.get("metadata") or {}
        if (
            p.get("sequenceType") == "first"
            and p.get("status") in ("open", "pending")
            and meta.get("intent") == "activate"
            and meta.get("billing_account_id") == account_id
        ):
            return mollie.checkout_url(p)
    return None


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
    percent_discount = account.get("percent_discount")
    type_discount = account.get("type_discount")
    seats = max(await count_account_seats(account_id), 1)
    customer_id = account.get("mollie_customer_id")
    sub_id = account.get("mollie_subscription_id")
    managed = is_managed(account)

    # Projected monthly total at the current tier + cadence. The discount applies
    # to the rolled-up totals, not the per-seat sticker rate: the sticker stays
    # the headline price and the discount is what reduces the actual bill, so the
    # displayed projection matches the (discounted) amount we send to Mollie.
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

    # Next invoice + payment method come from Mollie (best-effort). Managed
    # accounts have no Mollie subscription / mandate, so we skip those calls and
    # derive the next-invoice amount live from the seat count instead.
    next_invoice = None
    payment_method = None
    if managed:
        amount = managed_next_invoice_amount(account, seats)
        if amount is not None:
            next_invoice = {"date": None, "amount": f"{amount:.2f}", "currency": "EUR"}
    elif customer_id and sub_id:
        try:
            sub = await mollie.get_subscription(customer_id=customer_id, subscription_id=sub_id)
            amt = sub.get("amount") or {}
            # Display = Mollie's stored subscription amount (the real charge), not
            # a live re-derivation. Reconcile is now synchronous + flagged on every
            # seat path (ISSUE-001), so Mollie's amount is the source of truth: what
            # we show is exactly what will be debited. If reconcile failed, the flag
            # surfaces a "fix your payment" prompt rather than us quietly papering
            # over a stale amount.
            next_invoice = {
                "date": sub.get("nextPaymentDate"),
                "amount": amt.get("value"),
                "currency": amt.get("currency") or "EUR",
            }
        except mollie.MollieError:
            pass
    if customer_id and not managed:
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

    # Pending (un-accepted) invites are invisible in the seat count, so an admin
    # who just invited people would see a total that quietly understates the bill.
    # Surface the count + the projected total once those invites are accepted so
    # the dashboard can show a "rises to EURX when accepted" footnote.
    pending_invites = await count_account_pending_invites(account_id)
    projected_with_pending_eur: float | None = None
    if per_seat_monthly_eur is not None and pending_invites > 0:
        projected_with_pending_eur = apply_discount(
            per_seat_monthly_eur * (seats + pending_invites), percent_discount
        )

    account_manager = await _resolve_account_manager(account)

    # Paid-for-but-unfilled seats (watermark minus live): free to fill until renewal.
    watermark = account.get("provisioned_seats")
    available_seats = max(0, int(watermark) - seats) if watermark is not None else 0

    # Resume link for an unfinished first checkout (UI offers "Finish paying").
    pending_url = await pending_checkout_url(account_id) if status == "pending" else None

    return {
        "tier": tier,
        "status": status,
        "billing_period": billing_period,
        "seats": seats,
        "available_seats": available_seats,
        "pending_checkout_url": pending_url,
        # When the plan is winding down (status=="canceled") this is the date
        # access ends and the account drops to Free. Null while renewing.
        "current_period_end": account.get("tier_expires_at"),
        "next_invoice": next_invoice,
        "projected_monthly_eur": projected_monthly_eur,
        "per_seat_monthly_eur": per_seat_monthly_eur,
        "payment_method": payment_method,
        "pending_invites": pending_invites,
        "projected_with_pending_eur": projected_with_pending_eur,
        # Discount applied to every figure above (and to the live Mollie charge).
        # Surfaced so the UI can show "{n}% discount applied"; type is the reason
        # tag (scholarship / staff_discount / trial).
        "percent_discount": percent_discount,
        "type_discount": type_discount,
        # Observable seat-reconcile health: set when a re-price last failed
        # (dead mandate / Mollie error), null when clean. Drives the
        # "fix your payment" prompt.
        "reconcile_failed_at": account.get("reconcile_failed_at"),
        # Managed mode (ISSUE-021): the client UI hides self-serve controls and
        # shows a "managed by dembrane" panel with the account manager's contact.
        "is_managed": managed,
        "account_manager": account_manager,
        # Captured VAT + billing address (ISSUE-005, capture only).
        "billing_details": billing_details_from_account(account),
    }


async def _resolve_account_manager(account: dict) -> dict | None:
    """{name, email} of the assigned dembrane account manager (app_user), or
    None when unassigned. Shown on the billing page for managed accounts."""
    manager_id = account.get("account_manager_id")
    if not manager_id:
        return None
    # account_manager_id may arrive as a bare id or a joined dict.
    if isinstance(manager_id, dict):
        user = manager_id
    else:
        user = await async_directus.get_item("app_user", manager_id)
    if not user:
        return None
    return {"name": user.get("display_name") or user.get("email"), "email": user.get("email")}


# Captured VAT + address fields (ISSUE-005). Capture only: no rate logic.
BILLING_DETAIL_FIELDS = (
    "billing_legal_name",
    "billing_vat_id",
    "billing_vat_region",
    "billing_country",
    "billing_address_line1",
    "billing_address_line2",
    "billing_postal_code",
    "billing_city",
)


def billing_details_from_account(account: dict) -> dict:
    """The captured VAT/address fields off a billing_account dict."""
    return {f: account.get(f) for f in BILLING_DETAIL_FIELDS}


async def save_billing_details(account_id: str, details: dict) -> dict:
    """Persist VAT/address capture on the account (ISSUE-005). Only known fields
    are written; unknown keys are ignored. Returns the saved subset."""
    patch = {f: details[f] for f in BILLING_DETAIL_FIELDS if f in details}
    if patch:
        await async_directus.update_item("billing_account", account_id, patch)
    return patch


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

    # A subscription already exists (active or past_due): a consent checkout would
    # charge but _activate_from_first_payment no-ops. Past_due recovers via retry.
    # (Canceled clears the sub id, so the resume-fallback checkout still works.)
    if account.get("mollie_subscription_id") and account.get("status") in (
        "active",
        "past_due",
    ):
        raise BillingError("this account already has an active subscription")

    seats = await count_account_seats(account_id)
    amount, interval = _per_interval_amount(tier, seats, billing_period)
    # Real money: reduce the first charge by the account's discount so the
    # consent payment + the recurring subscription it spawns both bill the
    # discounted figure (the subscription inherits `amount` via metadata).
    amount = apply_discount(amount, account.get("percent_discount"))

    customer_id = await _ensure_customer(account)

    # Idempotency: reuse an in-flight consent payment rather than minting a
    # second one (double-click, back-button, two tabs). Two paid consent
    # payments would each be a real first-period charge — a double charge.
    try:
        for existing in await mollie.list_customer_payments(customer_id):
            existing_meta = existing.get("metadata") or {}
            if (
                existing.get("sequenceType") == "first"
                and existing.get("status") in ("open", "pending")
                and existing_meta.get("intent") == "activate"
                and existing_meta.get("billing_account_id") == account_id
            ):
                existing_url = mollie.checkout_url(existing)
                if existing_url:
                    logger.info(
                        "reusing in-flight consent payment %s for account %s",
                        existing.get("id"),
                        account_id,
                    )
                    return existing_url
    except mollie.MollieError as exc:
        # Non-fatal: fall through and create a fresh consent payment.
        logger.warning("Could not check for in-flight consent payment on %s: %s", account_id, exc)

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


async def start_update_payment_method(account_id: str, *, redirect_url: str) -> str:
    """Capture a new payment method on an existing account; return the checkout
    URL (ISSUE-002).

    Mollie has no customer portal, so a method change is a fresh consent
    ('first') payment of EUR 0.00: the card / PayPal mandate is captured without
    charging anything. The `intent="update_payment_method"` metadata is the gate
    the webhook + sync read so this consent payment does NOT spin up a second
    subscription (that would double-bill). The existing subscription rides the
    newest valid mandate, so once this one confirms we revoke the old mandates
    and the next renewal charges the new method.

    Status is left untouched (it stays active / past_due): this is a method swap,
    not a new purchase."""
    settings = get_settings()
    if not settings.billing.mollie_enabled:
        raise BillingError("Mollie is not configured")

    account = await async_directus.get_item("billing_account", account_id)
    if not account:
        raise BillingError("billing account not found")
    if not account.get("mollie_customer_id"):
        # No customer means no subscription to keep paying — there's nothing to
        # swap a method for. They should subscribe via checkout instead.
        raise BillingError("no payment profile to update; subscribe first")

    webhook_url = settings.billing.mollie_webhook_url
    customer_id = account["mollie_customer_id"]
    payment = await mollie.create_first_payment(
        customer_id=customer_id,
        amount_eur=0.0,
        description="Update payment method. No charge.",
        redirect_url=redirect_url,
        webhook_url=webhook_url,
        metadata={
            "billing_account_id": account_id,
            "intent": "update_payment_method",
        },
    )
    url = mollie.checkout_url(payment)
    if not url:
        raise BillingError("Mollie did not return a checkout URL")
    return url


async def _revoke_superseded_mandates(customer_id: str) -> int:
    """Revoke every valid mandate except the newest one (ISSUE-002).

    Called after a method-update consent payment confirms a fresh mandate. The
    subscription rides the newest valid mandate (never pinned), so dropping the
    older valid mandates leaves exactly the new method in place without touching
    the subscription. Returns how many were revoked. Best-effort: a failed
    revoke is logged, not raised (the new method already works)."""
    try:
        mandates = await mollie.list_mandates(customer_id)
    except mollie.MollieError as exc:
        logger.warning("Could not list mandates for %s: %s", customer_id, exc)
        return 0
    valid = [m for m in mandates if m.get("status") == "valid"]
    if len(valid) <= 1:
        return 0
    # Newest-first: Mollie returns mandates newest-first, so keep index 0 and
    # revoke the rest. Falling back to createdAt keeps us correct if that ever
    # changes.
    valid.sort(key=lambda m: m.get("createdAt") or "", reverse=True)
    revoked = 0
    for stale in valid[1:]:
        mid = stale.get("id")
        if not mid:
            continue
        try:
            await mollie.revoke_mandate(customer_id, mid)
            revoked += 1
        except mollie.MollieError as exc:
            logger.warning("Could not revoke mandate %s for %s: %s", mid, customer_id, exc)
    if revoked:
        logger.info("Revoked %d superseded mandate(s) for customer %s", revoked, customer_id)
    return revoked


async def handle_payment_method_updated(account_id: str, customer_id: str) -> None:
    """A method-update consent payment cleared (ISSUE-002 + ISSUE-008).

    Revoke the now-stale mandates so only the new method remains, then auto-retry
    any outstanding failed charge against the fresh mandate (founder decision:
    auto-retry on mandate update). Idempotent."""
    await _revoke_superseded_mandates(customer_id)
    # Updating the method is the natural recovery trigger for a past_due account.
    await retry_charge(account_id)


async def _activate_from_first_payment(account_id: str, meta: dict, customer_id: str) -> None:
    """First consent payment cleared: create the recurring subscription and
    activate the account.

    Serialized by a per-account Redis lock so the webhook, return-poll, and
    reconcile cron can't race into two `create_subscription` calls (the source
    of the duplicate-description 422). The `mollie_subscription_id` re-check
    inside the lock is the real idempotency guard; the lock just removes the
    window between read and write."""
    client, token = await _try_acquire_activation_lock(account_id)
    # Held by another in-flight activation (Redis up, lock taken) → let it win.
    if client is not None and token is None:
        logger.info("activation already in progress for %s; skipping", account_id)
        return
    try:
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
            # Defer the first recurring charge by one full period: the consent
            # payment already covered period 1, so charging on the start date
            # (Mollie's default) double-bills it.
            start_date=_subscription_start_date(billing_period),
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
                # Seed the proration baseline so a later seat-add prorates
                # (else the first reconcile baselines without charging).
                "provisioned_seats": seats,
                # Reactivation starts clean: stale flags would swallow the next
                # failure alert or show a phantom "fix your payment" prompt.
                "payment_failed_notified": False,
                "reconcile_failed_at": None,
            },
        )
        await invalidate_account_usage_caches(account_id)
        logger.info(
            "activated billing account %s on %s via Mollie sub %s",
            account_id,
            tier,
            sub.get("id"),
        )
    finally:
        await _release_activation_lock(account_id, client, token)


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

    payments = await mollie.list_customer_payments(customer_id)

    # Missed-webhook fallback: revoke superseded mandates after a paid method
    # update (idempotent). Auto-retry stays webhook/button-driven, never here.
    method_update_paid = any(
        p.get("sequenceType") == "first"
        and p.get("status") == "paid"
        and (p.get("metadata") or {}).get("billing_account_id") == account_id
        and (p.get("metadata") or {}).get("intent") == "update_payment_method"
        for p in payments
    )
    if method_update_paid:
        await _revoke_superseded_mandates(customer_id)

    if account.get("mollie_subscription_id"):
        return account.get("status") or "active"

    first_paid = next(
        (
            p
            for p in payments
            if p.get("sequenceType") == "first"
            and p.get("status") == "paid"
            and (p.get("metadata") or {}).get("billing_account_id") == account_id
            # A method-update consent payment must never activate / create a
            # subscription (ISSUE-002). It only swaps the stored mandate.
            and (p.get("metadata") or {}).get("intent") != "update_payment_method"
        ),
        None,
    )
    if first_paid:
        await _activate_from_first_payment(
            account_id, first_paid.get("metadata") or {}, customer_id
        )
        return "active"
    return account.get("status") or "pending"


def _period_end_iso(billing_period: str | None) -> str:
    """Fallback period end from now (when Mollie can't give us nextPaymentDate)."""
    days = 365 if billing_period == "annual" else 30
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()


def _subscription_start_date(billing_period: str | None) -> str:
    """First subscription-charge date (YYYY-MM-DD), one full period out from
    today. The consent payment covers period 1, so the subscription must not
    charge again until the next renewal — otherwise the customer is billed
    twice for the first period."""
    import calendar

    months = 12 if billing_period == "annual" else 1
    today = datetime.now(timezone.utc).date()
    year = today.year + (today.month - 1 + months) // 12
    month = (today.month - 1 + months) % 12 + 1
    day = min(today.day, calendar.monthrange(year, month)[1])
    return today.replace(year=year, month=month, day=day).isoformat()


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
    # Real money: the live subscription amount is the discounted figure, so a
    # re-price never silently restores the full rate.
    amount = apply_discount(amount, account.get("percent_discount"))

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


def _billing_context_key(account: dict | None) -> tuple[str, str] | None:
    """The data-ownership / billing context a workspace's account belongs to
    (ISSUE-033). Org-scoped → the org (internal workspaces in one org share it);
    workspace-scoped → that single external workspace (its own context). Returns
    None when the account is missing (can't establish a shared context)."""
    if not account:
        return None
    org_id = account.get("org_id")
    if org_id:
        return ("org", org_id)
    return ("workspace", account.get("id") or account.get("workspace_id") or "")


async def same_billing_context(workspace_a_id: str, workspace_b_id: str) -> bool:
    """Whether two workspaces share one billing / data-ownership context, so a
    project may move between them (ISSUE-033). Internal workspaces of the same
    org share the org context; an external (workspace-scoped) workspace is its
    own context and a project can't move out of it."""
    if workspace_a_id == workspace_b_id:
        return True
    key_a = _billing_context_key(await get_account_for_workspace(workspace_a_id))
    key_b = _billing_context_key(await get_account_for_workspace(workspace_b_id))
    # Unresolvable context (missing account) is never "same" — fail closed.
    return key_a is not None and key_a == key_b


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


async def _charge_seat_proration(
    account: dict, added_seats: int, *, provisioned_before: int | None = None
) -> float | None:
    """One-off prorated charge for `added_seats` added mid-cycle, off-session
    against the stored mandate. The caller has verified the account is active on
    a paid tier with a subscription.

    `provisioned_before` is the provisioned-seat baseline before this charge; it
    rides the payment metadata so the webhook can roll the baseline back if the
    charge later fails to settle (async methods like SEPA), letting the next
    reconcile retry it instead of silently dropping the owed amount (Fix D).

    Returns the amount charged, or None when there is legitimately nothing to
    charge (no remaining period, sub-cent amount, non-payable tier). Raises
    ReconcileChargeError when a charge was DUE but could not be placed: a
    dead/invalid mandate or a Mollie API error. The distinction lets reconcile
    flag the account on a real failure while staying silent on a no-op."""
    if added_seats < 1:
        return None
    # The caller (reconcile) has verified an active, paid-tier account with a
    # Mollie subscription, so tier + customer id are present.
    tier: str = account["tier"]
    customer_id: str = account["mollie_customer_id"]
    account_id = account.get("id")
    billing_period = account.get("billing_period") or "annual"

    fraction = await _period_fraction_remaining(account)
    if fraction <= 0:
        return None
    try:
        full_added, _interval = _per_interval_amount(tier, added_seats, billing_period)
    except BillingError:
        return None
    # Real money: discount the added-seat cost before prorating it.
    full_added = apply_discount(full_added, account.get("percent_discount"))
    prorated = round(full_added * fraction, 2)
    if prorated < 0.01:
        return None

    try:
        mandates = await mollie.list_mandates(customer_id)
    except mollie.MollieError as exc:
        raise ReconcileChargeError(
            f"Could not read mandates for account {account_id}: {exc}"
        ) from exc
    valid = next((m for m in mandates if m.get("status") == "valid"), None)
    if not valid:
        # A1/A2: a dead or invalid mandate is a real failure, not a no-op. The
        # seats were added; the charge is owed. Flag the account so the admin
        # gets the "fix your payment" prompt, and let the next reconcile retry.
        # B/ISSUE-008: also surface the dead mandate to the account admins so
        # they get a PAYMENT_FAILED notification, not just the reconcile flag.
        await _notify_payment_failed(account)
        raise ReconcileChargeError(
            f"No valid mandate on account {account_id}; proration charge owed but unpayable"
        )

    try:
        await mollie.create_recurring_payment(
            customer_id=customer_id,
            amount_eur=prorated,
            description=f"{added_seats} seat(s) added, prorated for the rest of this period",
            mandate_id=valid.get("id"),
            # Wire the webhook so a failed/async (SEPA) charge fires
            # _wh_seat_proration to roll back the optimistic baseline + flag.
            webhook_url=get_settings().billing.mollie_webhook_url or None,
            metadata={
                # billing_account_id + intent so the webhook can route this charge.
                "billing_account_id": account_id,
                "intent": "seat_proration",
                "added_seats": str(added_seats),
                "provisioned_before": provisioned_before,
            },
        )
    except mollie.MollieError as exc:
        logger.error("Proration charge failed for account %s: %s", account_id, exc)
        # B/ISSUE-008: surface the failed charge to the account admins, then
        # raise so A's reconcile-health flag stays accurate and the charge retries.
        await _notify_payment_failed(account)
        raise ReconcileChargeError(
            f"Proration charge failed for account {account_id}: {exc}"
        ) from exc

    logger.info(
        "charged %.2f EUR proration for %d seat(s) on account %s",
        prorated,
        added_seats,
        account_id,
    )
    return prorated


async def _set_reconcile_failed(account_id: str, account: dict, failed: bool) -> None:
    """Flip the observable reconcile-health flag (`reconcile_failed_at`), writing
    only on a real transition. Set to now on failure; clear to None on a clean
    pass. Idempotent: a clean account stays clean without a write, a flagged one
    stays flagged with the original timestamp until it recovers."""
    currently_failed = account.get("reconcile_failed_at") is not None
    if failed and not currently_failed:
        await async_directus.update_item(
            "billing_account",
            account_id,
            {"reconcile_failed_at": datetime.now(timezone.utc).isoformat()},
        )
    elif not failed and currently_failed:
        await async_directus.update_item(
            "billing_account", account_id, {"reconcile_failed_at": None}
        )


async def reconcile_account_seats(account_id: str) -> None:
    """Bring billing in line with the live seat count for one account. Idempotent
    and safe to call from both the seat-change endpoints and the periodic cron.

    - Re-prices the recurring subscription so the NEXT renewal matches current
      seats (both up and down).
    - On a net INCREASE above the high-watermark, charges a one-off prorated
      payment for the added seats covering the days left in the current period.
    - On a DECREASE, only the next renewal drops (no mid-cycle refund); the freed
      seat stays paid-for and reassignable until renewal (see below).

    `provisioned_seats` is the within-period HIGH-WATERMARK of seats paid for, not
    a live mirror: it only moves up here (on a charged increase) and is reset to
    the live count by the renewal webhook (_wh_subscription_charge). So removing a
    seat and backfilling it within the same period never re-charges — you pay for
    your peak concurrent seats once per period. No-op unless the account is active
    on a paid tier with a Mollie subscription.

    Flag contract (Wave A / ISSUE-001): on a Mollie failure -- a re-price error
    or a dead/invalid mandate when a proration charge is owed -- this sets
    `reconcile_failed_at=now`, does NOT advance `provisioned_seats`, and does NOT
    re-raise (a billing hiccup never blocks collaboration). A clean pass clears
    the flag. The seat change always stands; the flag is what the dashboard reads
    to show the "fix your payment" prompt, and the next reconcile retries.

    Managed accounts (`payment_mode == 'offline'`) take the invoice-only path:
    the seat count + next-invoice amount are recorded, but no Mollie charge
    (proration or subscription re-price) ever fires. Staff issues the invoice."""
    account = await async_directus.get_item("billing_account", account_id)
    if not account or account.get("status") != "active":
        return
    tier = account.get("tier")
    if not tier or tier == "free":
        return

    # Managed: record the number, never charge. No Mollie subscription is
    # required (managed accounts pay by invoice, not by mandate).
    if is_managed(account):
        await _reconcile_managed_seats(account)
        return

    if not account.get("mollie_subscription_id"):
        return

    try:
        # Test-mode escape hatch (A2): emulate a Mollie reconcile failure on
        # demand so the failure path (flag + "fix your payment" prompt) can be
        # tested together. Only honoured under a Mollie test key; never in prod.
        if get_settings().billing.reconcile_failure_forced:
            raise ReconcileChargeError(
                f"Forced reconcile failure (MOLLIE_FORCE_RECONCILE_FAILURE) on {account_id}"
            )

        # The next renewal always reflects the live seat count. A re-price error
        # (Mollie PATCH) propagates here and flags the account.
        await sync_subscription_seats(account_id)

        current = max(await count_account_seats(account_id), 1)
        provisioned = account.get("provisioned_seats")

        # First reconcile for this account: set the baseline, never charge for
        # seats that predate proration tracking.
        if provisioned is None:
            await async_directus.update_item(
                "billing_account", account_id, {"provisioned_seats": current}
            )
            await _set_reconcile_failed(account_id, account, failed=False)
            return

        if current > provisioned:
            # Advance the baseline optimistically so a re-reconcile can't double-
            # charge; the webhook rolls it back if the charge fails to settle.
            charged = await _charge_seat_proration(
                account, current - provisioned, provisioned_before=provisioned
            )
            if charged is not None:
                await async_directus.update_item(
                    "billing_account", account_id, {"provisioned_seats": current}
                )
        # Don't lower provisioned_seats on a decrease: it's the period's high-
        # watermark (freed seats stay reassignable; the renewal webhook resets it).
    except (ReconcileChargeError, mollie.MollieError) as exc:
        # Allow + flag: the seat change already happened, the bill is owed, but
        # Mollie couldn't be brought in line. Flag for the prompt; do not re-raise.
        logger.error("Seat reconcile failed for account %s: %s", account_id, exc)
        await _set_reconcile_failed(account_id, account, failed=True)
        return

    # Clean pass: clear any stale failure flag.
    await _set_reconcile_failed(account_id, account, failed=False)


def managed_next_invoice_amount(account: dict, seats: int) -> float | None:
    """The amount staff would invoice for `seats` at the account's tier +
    cadence. None when the tier isn't payable. Used to record the next-invoice
    figure on a managed account without charging anything."""
    tier = account.get("tier")
    billing_period = account.get("billing_period") or "annual"
    if not tier or tier == "free":
        return None
    try:
        amount, _interval = _per_interval_amount(tier, seats, billing_period)
    except BillingError:
        return None
    return amount


async def _reconcile_managed_seats(account: dict) -> None:
    """Managed-account reconcile: record the live seat count (`provisioned_seats`)
    so staff can see what to invoice. Never charges — managed accounts have no
    mandate and pay by invoice (ISSUE-021). The next-invoice amount is derived
    live in the overview from this count, not persisted. Idempotent."""
    account_id = account["id"]
    current = max(await count_account_seats(account_id), 1)
    amount = managed_next_invoice_amount(account, current)
    await async_directus.update_item("billing_account", account_id, {"provisioned_seats": current})
    logger.info(
        "managed reconcile for account %s: %d seat(s), next invoice %s EUR (no charge)",
        account_id,
        current,
        amount,
    )


async def issue_offline_payment_link(
    account_id: str,
    *,
    amount_eur: float | None = None,
    description: str | None = None,
    redirect_url: str | None = None,
) -> dict:
    """Create a Mollie payment link for a managed account's invoice (C2 default).

    The buyer pays out-of-band (bank transfer is offered on the hosted page) and
    the existing webhook reconcile marks the account active. No subscription or
    mandate. When `amount_eur` is omitted it defaults to the account's current
    seats x per-seat price. Returns {"payment_link_id", "url", "amount_eur"}."""
    settings = get_settings()
    if not settings.billing.mollie_enabled:
        raise BillingError("Mollie is not configured")
    account = await async_directus.get_item("billing_account", account_id)
    if not account:
        raise BillingError("billing account not found")

    seats = max(await count_account_seats(account_id), 1)
    if amount_eur is None:
        amount_eur = managed_next_invoice_amount(account, seats)
    if amount_eur is None or amount_eur < 0.01:
        raise BillingError("no invoice amount for this account")

    tier = account.get("tier") or "managed"
    desc = description or _plan_description(tier, seats, account.get("billing_period") or "annual")
    link = await mollie.create_payment_link(
        amount_eur=amount_eur,
        description=desc,
        webhook_url=settings.billing.mollie_webhook_url or None,
        redirect_url=redirect_url,
        metadata={
            "billing_account_id": account_id,
            "intent": "offline_invoice",
            "tier": tier,
            "seats": seats,
        },
    )
    url = mollie.payment_link_url(link)
    if not url:
        raise BillingError("Mollie did not return a payment link URL")
    logger.info(
        "issued offline payment link for managed account %s: %.2f EUR",
        account_id,
        amount_eur,
    )
    return {"payment_link_id": link.get("id"), "url": url, "amount_eur": amount_eur}


def _invoice_recipient(account: dict) -> dict:
    """Build the Mollie sales-invoice recipient from the captured VAT/address
    fields. Capture only: we forward what the customer entered, Mollie computes
    VAT (no rate logic here — ISSUE-005 Q1, blocked on Marco)."""
    recipient: dict = {
        "type": "business" if account.get("billing_vat_id") else "consumer",
        "organizationName": account.get("billing_legal_name") or account.get("label"),
        "streetAndNumber": account.get("billing_address_line1"),
        "postalCode": account.get("billing_postal_code"),
        "city": account.get("billing_city"),
        "country": account.get("billing_country"),
    }
    if account.get("billing_address_line2"):
        recipient["streetAdditional"] = account["billing_address_line2"]
    if account.get("billing_vat_id"):
        recipient["vatNumber"] = account["billing_vat_id"]
    # Drop empty keys so we never send blanks to Mollie.
    return {k: v for k, v in recipient.items() if v}


async def issue_sales_invoice(
    account_id: str,
    *,
    seats: int | None = None,
    amount_eur: float | None = None,
    mark_paid: bool = False,
    is_einvoice: bool = False,
    payment_details: dict | None = None,
) -> dict:
    """Create a Mollie sales invoice for a managed account (ISSUE-004).

    `mark_paid=False` issues it (status='issued' -> Mollie auto-numbers).
    `mark_paid=True` records an already-paid invoice (status='paid', requires
    `payment_details`) — the managed flow where the buyer paid out-of-band.
    Carries the captured VAT/address as the recipient and the e-invoice flag.
    Returns {"invoice_id", "status"}."""
    settings = get_settings()
    if not settings.billing.mollie_enabled:
        raise BillingError("Mollie is not configured")
    account = await async_directus.get_item("billing_account", account_id)
    if not account:
        raise BillingError("billing account not found")

    if seats is None:
        seats = max(await count_account_seats(account_id), 1)
    if amount_eur is None:
        amount_eur = managed_next_invoice_amount(account, seats)
    if amount_eur is None or amount_eur < 0.01:
        raise BillingError("no invoice amount for this account")

    tier = account.get("tier") or "managed"
    line_desc = _plan_description(tier, seats, account.get("billing_period") or "annual")
    # Quantity 1 with the full amount: per-seat math is already rolled into the
    # amount, matching how the subscription is priced (no Mollie quantity field).
    lines = [
        {
            "description": line_desc,
            "quantity": 1,
            "vatRate": "0.00",  # capture-only; rate ruleset gated on Marco (ISSUE-005 Q1)
            "unitPrice": _amount_dict(amount_eur),
        }
    ]
    status = "paid" if mark_paid else "issued"
    invoice = await mollie.create_sales_invoice(
        status=status,
        recipient=_invoice_recipient(account),
        lines=lines,
        payment_details=payment_details if mark_paid else None,
        is_einvoice=is_einvoice,
        metadata={"billing_account_id": account_id, "tier": tier, "seats": seats},
    )
    logger.info(
        "issued sales invoice %s (status=%s) for account %s: %.2f EUR",
        invoice.get("id"),
        status,
        account_id,
        amount_eur,
    )
    return {"invoice_id": invoice.get("id"), "status": invoice.get("status") or status}


async def get_sales_invoice_pdf_url(invoice_id: str) -> str | None:
    """The downloadable PDF URL for a sales invoice (`_links.pdfLink.href`)."""
    invoice = await mollie.get_sales_invoice(invoice_id)
    return mollie.sales_invoice_pdf_url(invoice)


def _amount_dict(value_eur: float) -> dict[str, str]:
    return {"currency": "EUR", "value": f"{value_eur:.2f}"}


async def estimate_seat_addition(
    account_id: str,
    added_seats: int = 1,
    *,
    recipient_emails: list[str] | None = None,
) -> dict:
    """Preview the cost of adding seats, for the invite confirm dialog: the
    one-off prorated charge now plus how much the recurring renewal goes up.

    `active` is False when there's nothing to charge (free / not subscribed), and
    the UI shows no charge (or the reactivate gate) in that case.

    Net-new (founder rule A1): when `recipient_emails` is given, the quote is
    computed server-side over the NET-NEW seats only. A recipient who already
    holds an active seat anywhere on the account, or already has a pending
    invite, adds nothing (seats are pooled). Inviting only existing members
    quotes EUR0. The roster is never returned to the client, only the resulting
    seat count + amounts. When no emails are given, fall back to `added_seats`."""
    account = await async_directus.get_item("billing_account", account_id)
    billing_period = (account or {}).get("billing_period") or "annual"

    if recipient_emails is not None:
        effective_added = await count_net_new_seats(account_id, recipient_emails)
    else:
        effective_added = max(0, added_seats)

    result = {
        "active": False,
        "added_seats": effective_added,
        "billing_period": billing_period,
        "currency": "EUR",
        "prorated_now_eur": 0.0,
        "recurring_delta_eur": 0.0,
        # Invited seats covered by capacity already paid for (a seat freed
        # earlier): free now, only the renewal rises.
        "covered_by_existing_seats": 0,
    }
    if not account or account.get("status") != "active":
        return result
    tier = account.get("tier")
    if not tier or tier == "free" or not account.get("mollie_subscription_id"):
        return result
    # Active subscription, but every recipient is already a seat: net-new is 0,
    # so the quote is EUR0. `active` stays True so the UI can say "this costs
    # nothing" rather than misreading it as an inactive plan.
    if effective_added < 1:
        result["active"] = True
        return result

    # Charge only seats beyond the high-watermark now; the rest reuse paid-for
    # capacity. Renewal still rises by every net-new seat (it bills live count).
    watermark = account.get("provisioned_seats")
    if watermark is None:
        chargeable_now = effective_added
    else:
        current_live = max(await count_account_seats(account_id), 1)
        chargeable_now = max(0, (current_live + effective_added) - int(watermark))
    result["covered_by_existing_seats"] = effective_added - chargeable_now

    discount = account.get("percent_discount")
    try:
        full_added, _interval = _per_interval_amount(tier, effective_added, billing_period)
    except BillingError:
        return result
    fraction = await _period_fraction_remaining(account)
    result["active"] = True
    # Match the real charge: discount so the preview equals what reconcile bills.
    result["recurring_delta_eur"] = round(apply_discount(full_added, discount), 2)
    if chargeable_now > 0:
        chargeable, _ = _per_interval_amount(tier, chargeable_now, billing_period)
        result["prorated_now_eur"] = round(apply_discount(chargeable, discount) * fraction, 2)
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


def _still_within_paid_period(tier_expires_at: str | None) -> bool:
    """True when `tier_expires_at` is a future instant: the customer still holds
    a period they already paid for. Used so a resume inside that window does not
    re-charge it (Fix C)."""
    if not tier_expires_at:
        return False
    try:
        end = datetime.fromisoformat(tier_expires_at)
    except ValueError:
        return False
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)
    return end > datetime.now(timezone.utc)


async def resume_subscription(account_id: str) -> dict:
    """Undo a cancellation without re-charging a period already paid for (Fix C).

    A canceled account keeps its tier until `tier_expires_at`. If the customer
    resumes inside that window and a live mandate still exists, we recreate the
    Mollie subscription starting at the existing period end (no consent charge,
    no lost days) and flip the account back to active. The old subscription was
    deleted on cancel; the mandate was not, so the new subscription rides it.

    Returns {"resumed": bool, "status": str}. `resumed=False` means there is
    nothing pre-paid to preserve (period lapsed, tier no longer payable) or no
    live mandate to ride, so the caller should start a fresh checkout instead —
    that path captures a new mandate and legitimately charges for a new period.
    Idempotent: resuming an already-active account is a no-op (resumed False)."""
    settings = get_settings()
    if not settings.billing.mollie_enabled:
        raise BillingError("Mollie is not configured")

    account = await async_directus.get_item("billing_account", account_id)
    if not account:
        raise BillingError("billing account not found")

    status = account.get("status")
    tier = account.get("tier")
    customer_id = account.get("mollie_customer_id")
    billing_period = account.get("billing_period") or "annual"
    expires_at = account.get("tier_expires_at")

    # Only a canceled account, still inside its pre-paid period, on a payable
    # tier, with a Mollie customer, can resume without paying again.
    if (
        status != "canceled"
        or not tier
        or tier == "free"
        or not customer_id
        or not _still_within_paid_period(expires_at)
    ):
        return {"resumed": False, "status": status or "none"}

    # The subscription rides the newest valid mandate. With none left we can't
    # set up off-session billing, so fall back to checkout (re-captures consent).
    try:
        mandates = await mollie.list_mandates(customer_id)
    except mollie.MollieError as exc:
        logger.warning("Could not list mandates to resume %s: %s", account_id, exc)
        return {"resumed": False, "status": status}
    if not any(m.get("status") == "valid" for m in mandates):
        return {"resumed": False, "status": status}

    seats = max(await count_account_seats(account_id), 1)
    try:
        amount, interval = _per_interval_amount(tier, seats, billing_period)
    except BillingError:
        return {"resumed": False, "status": status}
    amount = apply_discount(amount, account.get("percent_discount"))

    # Start the new subscription at the existing period end: no charge now, the
    # customer keeps the days already paid for.
    try:
        start_date = datetime.fromisoformat(expires_at).date().isoformat()
    except ValueError:
        start_date = _subscription_start_date(billing_period)

    sub = await mollie.create_subscription(
        customer_id=customer_id,
        amount_eur=amount,
        interval=interval,
        description=_plan_description(tier, seats, billing_period),
        start_date=start_date,
        webhook_url=settings.billing.mollie_webhook_url or "",
        metadata={"billing_account_id": account_id},
    )
    await async_directus.update_item(
        "billing_account",
        account_id,
        {
            "status": "active",
            "payment_mode": "mollie",
            "mollie_subscription_id": sub.get("id"),
            # Re-baseline to the resumed seat count; clear stale dunning flags.
            "provisioned_seats": seats,
            "payment_failed_notified": False,
            "reconcile_failed_at": None,
        },
    )
    await invalidate_account_usage_caches(account_id)
    logger.info(
        "resumed billing account %s on %s; new sub %s starts %s (no charge now)",
        account_id,
        tier,
        sub.get("id"),
        start_date,
    )
    return {"resumed": True, "status": "active"}


# ── Failed-charge surfacing (ISSUE-008) — notify only, never block ──────────


async def _notify_payment_failed(account: dict) -> None:
    """Notify the account's owner + admins that a charge failed (ISSUE-008).

    Founder decision (2026-06-18): the plan stays fully ACTIVE. We only surface
    the failure (Inbox + email) so they can fix the payment method. Throttled by
    the `payment_failed_notified` flag so a string of failed retries in one
    past_due window doesn't spam. The email omits the EUR amount on purpose (B1:
    shown in-app, not in the email). Best-effort: never raises."""
    account_id: str = account["id"]
    if account.get("payment_failed_notified"):
        return  # already told them this cycle

    from dembrane.notifications import emit_to_audience, audience_billing_account_admins

    try:
        audience = await audience_billing_account_admins(account)
    except Exception as exc:  # noqa: BLE001 — notifications are best-effort
        logger.warning("Could not resolve payment-failed audience for %s: %s", account_id, exc)
        audience = []

    if audience:
        # ref_workspace_id / ref_org_id drive the NAVIGATE_BILLING deep link.
        await emit_to_audience(
            audience_user_ids=audience,
            event_code="PAYMENT_FAILED",
            title="We couldn't charge your payment method",
            message=(
                "Your last payment didn't go through. Update your payment method "
                "to keep your plan. Your access stays on while you sort it out."
            ),
            action="NAVIGATE_BILLING",
            ref_workspace_id=account.get("workspace_id"),
            ref_org_id=account.get("org_id"),
        )

    # Email the owner + admins. Same tone, no amount.
    try:
        await _email_payment_failed(account, audience)
    except Exception as exc:  # noqa: BLE001 — email is best-effort
        logger.warning("payment-failed email failed for %s: %s", account_id, exc)

    try:
        await async_directus.update_item(
            "billing_account", account_id, {"payment_failed_notified": True}
        )
    except Exception as exc:  # noqa: BLE001 — notifications are best-effort
        logger.warning("Could not set payment_failed_notified for %s: %s", account_id, exc)
        return
    logger.info("notified owner+admins of failed charge on account %s", account_id)


async def _email_payment_failed(account: dict, audience_user_ids: list[str]) -> None:
    """Send the failed-charge email to the audience's addresses (ISSUE-008)."""
    if not audience_user_ids:
        return
    from dembrane.email import send_email

    rows = await async_directus.get_items(
        "app_user",
        {"query": {"filter": {"id": {"_in": audience_user_ids}}, "fields": ["email"], "limit": -1}},
    )
    emails = sorted(
        {
            (r.get("email") or "").strip()
            for r in (rows if isinstance(rows, list) else [])
            if isinstance(r, dict) and r.get("email")
        }
    )
    if not emails:
        return

    settings = get_settings()
    base = (settings.urls.admin_base_url or "").rstrip("/")
    workspace_id = account.get("workspace_id")
    org_id = account.get("org_id")
    if workspace_id:
        billing_url = f"{base}/w/{workspace_id}/settings/billing"
    elif org_id:
        billing_url = f"{base}/o/{org_id}/settings/billing"
    else:
        billing_url = base or "/"

    for email_addr in emails:
        await send_email(
            to=email_addr,
            subject="Action needed: update your payment method",
            template="payment_failed",
            template_data={"billing_url": billing_url},
        )


async def _mark_past_due(account_id: str) -> None:
    """A recurring charge failed: mark past_due and notify once (ISSUE-008).

    No downgrade, no cap, no lockout (founder decision). The plan stays active;
    only the status flips so the UI can show the banner and we can prompt a fix."""
    account = await async_directus.get_item("billing_account", account_id)
    if not account:
        return
    await async_directus.update_item("billing_account", account_id, {"status": "past_due"})
    # Re-read just the flag off the fetched account; status was just written.
    await _notify_payment_failed(account)


async def _mark_recovered(account_id: str) -> None:
    """A recurring charge cleared: back to active and clear the throttle flag so
    the next failure can notify again (ISSUE-008 recovery, B5)."""
    account = await async_directus.get_item("billing_account", account_id)
    patch: dict = {"status": "active"}
    if account and account.get("payment_failed_notified"):
        patch["payment_failed_notified"] = False
    await async_directus.update_item("billing_account", account_id, patch)


async def retry_charge(account_id: str) -> str:
    """Retry the outstanding charge off-session against the newest valid mandate
    (ISSUE-008 "retry now" button + auto-retry on mandate update).

    No-op unless the account is past_due with a customer and a valid mandate. On
    a successful charge we flip status back to active and clear the notification
    throttle. The Mollie payment's webhook also reconciles, so this is a fast
    path, not the only path. Returns the resulting status."""
    account = await async_directus.get_item("billing_account", account_id)
    if not account:
        return "none"
    if account.get("status") != "past_due":
        return account.get("status") or "none"

    customer_id = account.get("mollie_customer_id")
    tier = account.get("tier")
    billing_period = account.get("billing_period") or "annual"
    if not customer_id or not tier or tier == "free":
        return "past_due"

    try:
        mandates = await mollie.list_mandates(customer_id)
    except mollie.MollieError as exc:
        logger.warning("Could not list mandates for retry on %s: %s", account_id, exc)
        return "past_due"
    valid = next((m for m in mandates if m.get("status") == "valid"), None)
    if not valid:
        logger.info("No valid mandate to retry charge on account %s", account_id)
        return "past_due"

    seats = max(await count_account_seats(account_id), 1)
    try:
        amount, _interval = _per_interval_amount(tier, seats, billing_period)
    except BillingError:
        return "past_due"

    try:
        payment = await mollie.create_recurring_payment(
            customer_id=customer_id,
            amount_eur=amount,
            description=_plan_description(tier, seats, billing_period),
            mandate_id=valid.get("id"),
            webhook_url=get_settings().billing.mollie_webhook_url or None,
            metadata={"billing_account_id": account_id, "intent": "retry_charge"},
        )
    except mollie.MollieError as exc:
        logger.warning("Retry charge failed for account %s: %s", account_id, exc)
        return "past_due"

    # Only a settled 'paid' recovers; 'pending' (e.g. SEPA) stays past_due until
    # the webhook confirms, so a later failure can't leave it falsely active.
    status = payment.get("status")
    if status != "paid":
        logger.info(
            "Retry charge for account %s came back %s; awaiting webhook", account_id, status
        )
        return "past_due"
    await _mark_recovered(account_id)
    logger.info("retry charge succeeded for account %s (%s)", account_id, status)
    return "active"


_FAILED_STATUSES = ("failed", "expired", "canceled")


async def _wh_offline_invoice(account_id: str, status: str | None) -> None:
    """Managed/offline invoice paid via a payment link (ISSUE-006 / C2). No
    subscription or mandate: mark active and keep it managed. Entitlements are
    decoupled from payment in managed mode, so a failed/expired offline payment
    must NOT drop the account (the buyer pays out-of-band against a PO)."""
    if status == "paid":
        await async_directus.update_item(
            "billing_account",
            account_id,
            {"status": "active", "payment_mode": "offline", "tier_expires_at": None},
        )
        logger.info("offline invoice paid for managed account %s; kept active", account_id)


async def _wh_retry_charge(account_id: str, status: str | None) -> None:
    """Outcome of a past_due 'retry now' charge (Fix D). Paid recovers; a failed
    settlement re-flips past_due (so an optimistic local 'active' is corrected)."""
    if status == "paid":
        await _mark_recovered(account_id)
    elif status in _FAILED_STATUSES:
        await _mark_past_due(account_id)


async def _wh_seat_proration(account_id: str, meta: dict, status: str | None) -> None:
    """Outcome of a mid-cycle seat-proration charge (Fix D). On failure, roll the
    provisioned-seat baseline back to before this charge so the next reconcile
    retries the owed amount, then flag + notify. 'paid' is a no-op (the baseline
    already advanced optimistically at charge time)."""
    if status not in _FAILED_STATUSES:
        return
    account = await async_directus.get_item("billing_account", account_id)
    if not account:
        return
    before = meta.get("provisioned_before")
    if before is not None:
        await async_directus.update_item(
            "billing_account", account_id, {"provisioned_seats": int(before)}
        )
    await _set_reconcile_failed(account_id, account, failed=True)
    await _notify_payment_failed(account)


async def _wh_method_update(account_id: str, customer_id: str | None, status: str | None) -> None:
    """Outcome of a method-update consent (ISSUE-002 + Fix A). On 'paid', capture
    the new mandate, drop the stale ones, and auto-retry any outstanding charge —
    NEVER create a subscription. Any non-paid outcome (including a cancelled /
    expired consent) is a no-op: a method swap never changes account status."""
    if status == "paid" and customer_id:
        await handle_payment_method_updated(account_id, customer_id)


async def _wh_first_payment(
    account_id: str, meta: dict, customer_id: str | None, status: str | None
) -> None:
    """Outcome of a new-purchase consent ('first' payment, intent=activate). Paid
    activates the account (creates the subscription); a failed/expired/canceled
    consent only rolls the 'pending' account it created back to 'none' (Fix A:
    never downgrade an already-active/past_due/canceled account)."""
    if status == "paid":
        if customer_id:
            await _activate_from_first_payment(account_id, meta, customer_id)
        return
    if status in _FAILED_STATUSES:
        account = await async_directus.get_item("billing_account", account_id)
        if account and account.get("status") == "pending":
            await async_directus.update_item("billing_account", account_id, {"status": "none"})


async def _reset_provisioned_baseline(account_id: str) -> None:
    """Reset the seat high-watermark to the live seat count. Called when a
    renewal opens a new period: seats freed during the prior period (kept on the
    watermark so they stayed reassignable) stop being paid-for from here, and the
    renewal itself bills the live count."""
    current = max(await count_account_seats(account_id), 1)
    await async_directus.update_item(
        "billing_account", account_id, {"provisioned_seats": current}
    )


async def _wh_subscription_charge(account_id: str, status: str | None) -> None:
    """Outcome of a recurring subscription charge: paid keeps it active (recovers
    a past_due) and opens a new period, a failed/expired/canceled charge marks
    past_due (ISSUE-008)."""
    if status == "paid":
        await _mark_recovered(account_id)
        # A renewal opens a new period: reset the seat high-watermark to live count.
        await _reset_provisioned_baseline(account_id)
    elif status in _FAILED_STATUSES:
        await _mark_past_due(account_id)


async def handle_mollie_webhook(payment_id: str) -> None:
    """Process a Mollie payment webhook. Re-fetches the payment (never trusts the
    POST body), then routes it to the handler for its (intent, shape, status).
    Idempotent.

    Routing is explicit and exhaustive: every payment is dispatched by its
    metadata intent (the charges we placed ourselves carry one), then by payment
    shape (first-payment consent vs subscription renewal). Anything that matches
    no handler is logged rather than silently dropped, so a new payment kind
    can't quietly fall through to the wrong default."""
    payment = await mollie.get_payment(payment_id)
    meta = payment.get("metadata") or {}
    account_id = meta.get("billing_account_id")
    if not account_id:
        logger.warning("Mollie webhook for %s has no billing_account_id; ignoring", payment_id)
        return
    status = payment.get("status")
    customer_id = payment.get("customerId")
    sequence = payment.get("sequenceType")
    intent = meta.get("intent")

    # 1) Charges that carry an explicit intent we set ourselves.
    if intent == "offline_invoice":
        await _wh_offline_invoice(account_id, status)
        return
    if intent == "retry_charge":
        await _wh_retry_charge(account_id, status)
        return
    if intent == "seat_proration":
        await _wh_seat_proration(account_id, meta, status)
        return
    if intent == "update_payment_method":
        await _wh_method_update(account_id, customer_id, status)
        return

    # 2) Routed by shape: a new-purchase consent, then a subscription renewal.
    if sequence == "first":
        await _wh_first_payment(account_id, meta, customer_id, status)
        return
    if payment.get("subscriptionId"):
        await _wh_subscription_charge(account_id, status)
        return

    logger.info(
        "Mollie webhook %s (intent=%r sequence=%r status=%r) matched no handler; ignoring",
        payment_id,
        intent,
        sequence,
        status,
    )
