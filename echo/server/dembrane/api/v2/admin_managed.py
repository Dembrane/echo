"""Staff-only managed-billing endpoints (Wave C / ISSUE-021, 006, 004, 005).

Kept in a dedicated router (not admin.py) so it stays additive alongside the
staff-dashboard work in ISSUE-022 / Wave E. Mounted under /v2/admin, so every
route here is staff-gated the same way as admin.py (the is_admin JWT claim).

Surface:
  POST   /admin/billing-accounts/{id}/set-managed         flip to managed
  POST   /admin/billing-accounts/{id}/account-manager     assign manager
  DELETE /admin/billing-accounts/{id}/account-manager     clear manager
  POST   /admin/billing-accounts/{id}/issue-payment-link  offline pay link
  POST   /admin/billing-accounts/{id}/issue-invoice       Mollie sales invoice
  POST   /admin/billing-accounts/{id}/mark-invoice-paid   record an out-of-band payment

The account manager is an app_user whose email ends @dembrane.com (staff have
normal app logins) - validated here, not in Directus.
"""

from __future__ import annotations

from typing import Optional
from logging import getLogger

from fastapi import APIRouter, HTTPException
from pydantic import Field, BaseModel

from dembrane import billing_service
from dembrane.directus_async import async_directus
from dembrane.api.dependency_auth import DependencyDirectusSession

router = APIRouter()
logger = getLogger("api.v2.admin_managed")

STAFF_EMAIL_DOMAIN = "@dembrane.com"


def _require_staff(auth: DependencyDirectusSession) -> None:
    if not auth.is_admin:
        raise HTTPException(status_code=403, detail="Staff-only")


async def _get_account(account_id: str) -> dict:
    account = await async_directus.get_item("billing_account", account_id)
    if not account or account.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Billing account not found")
    return account


async def _validate_account_manager(app_user_id: str) -> dict:
    """The app_user must exist and have a @dembrane.com email (C1). Returns the
    user dict; raises 400 otherwise."""
    user = await async_directus.get_item("app_user", app_user_id)
    if not user:
        raise HTTPException(status_code=400, detail="Account manager user not found")
    email = (user.get("email") or "").strip().lower()
    if not email.endswith(STAFF_EMAIL_DOMAIN):
        raise HTTPException(
            status_code=400,
            detail="Account manager must be a dembrane staff member (@dembrane.com).",
        )
    return user


class SetManagedBody(BaseModel):
    tier: str = Field(description="Tier to grant on the managed account.")
    seats: Optional[int] = Field(default=None, ge=0, description="Recorded seat count.")
    account_manager_id: Optional[str] = Field(
        default=None, description="app_user (@dembrane.com) to assign as manager."
    )


@router.post("/billing-accounts/{account_id}/set-managed")
async def set_managed(
    account_id: str,
    body: SetManagedBody,
    auth: DependencyDirectusSession,
) -> dict:
    """Flip an account to managed by dembrane (`payment_mode='offline'`).

    Sets the tier, optionally the recorded seat count and account manager, and
    clears any auto-expiry (managed accounts never auto-downgrade). Full features
    stay on; no Mollie subscription is created."""
    _require_staff(auth)
    await _get_account(account_id)

    patch: dict = {
        "payment_mode": "offline",
        "tier": body.tier,
        "status": "active",
        # Managed accounts are not on the auto-expiry / dunning treadmill.
        "tier_expires_at": None,
        "pre_warning_sent": False,
    }
    if body.seats is not None:
        patch["provisioned_seats"] = body.seats
    if body.account_manager_id is not None:
        await _validate_account_manager(body.account_manager_id)
        patch["account_manager_id"] = body.account_manager_id

    await async_directus.update_item("billing_account", account_id, patch)
    logger.info(
        "staff %s set account %s managed (tier=%s, seats=%s, manager=%s)",
        auth.user_id,
        account_id,
        body.tier,
        body.seats,
        body.account_manager_id,
    )
    return {"status": "ok", "billing_account_id": account_id, "payment_mode": "offline"}


class AssignManagerBody(BaseModel):
    account_manager_id: str = Field(description="app_user (@dembrane.com) id.")


@router.post("/billing-accounts/{account_id}/account-manager")
async def assign_account_manager(
    account_id: str,
    body: AssignManagerBody,
    auth: DependencyDirectusSession,
) -> dict:
    """Assign the dembrane account manager (any staff member can assign any
    @dembrane.com app_user). Shows on the client billing page."""
    _require_staff(auth)
    await _get_account(account_id)
    user = await _validate_account_manager(body.account_manager_id)
    await async_directus.update_item(
        "billing_account", account_id, {"account_manager_id": body.account_manager_id}
    )
    logger.info(
        "staff %s assigned account manager %s to account %s",
        auth.user_id,
        body.account_manager_id,
        account_id,
    )
    return {
        "status": "ok",
        "account_manager": {
            "name": user.get("display_name") or user.get("email"),
            "email": user.get("email"),
        },
    }


@router.delete("/billing-accounts/{account_id}/account-manager")
async def clear_account_manager(
    account_id: str,
    auth: DependencyDirectusSession,
) -> dict:
    """Clear the assigned account manager."""
    _require_staff(auth)
    await _get_account(account_id)
    await async_directus.update_item(
        "billing_account", account_id, {"account_manager_id": None}
    )
    logger.info("staff %s cleared account manager on account %s", auth.user_id, account_id)
    return {"status": "ok"}


class IssuePaymentLinkBody(BaseModel):
    amount_eur: Optional[float] = Field(
        default=None, gt=0, description="Override; defaults to seats x per-seat price."
    )
    description: Optional[str] = None
    redirect_url: Optional[str] = None


@router.post("/billing-accounts/{account_id}/issue-payment-link")
async def issue_payment_link(
    account_id: str,
    body: IssuePaymentLinkBody,
    auth: DependencyDirectusSession,
) -> dict:
    """Issue a Mollie payment link for a managed account (C2 default). The buyer
    pays out-of-band (bank transfer supported); the webhook reconciles."""
    _require_staff(auth)
    await _get_account(account_id)
    try:
        out = await billing_service.issue_offline_payment_link(
            account_id,
            amount_eur=body.amount_eur,
            description=body.description,
            redirect_url=body.redirect_url,
        )
    except billing_service.BillingError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    logger.info("staff %s issued payment link for account %s", auth.user_id, account_id)
    return {"status": "ok", **out}


class IssueInvoiceBody(BaseModel):
    seats: Optional[int] = Field(default=None, ge=0)
    amount_eur: Optional[float] = Field(default=None, gt=0)
    is_einvoice: bool = Field(default=False, description="Toggle the e-invoice flag.")


@router.post("/billing-accounts/{account_id}/issue-invoice")
async def issue_invoice(
    account_id: str,
    body: IssueInvoiceBody,
    auth: DependencyDirectusSession,
) -> dict:
    """Issue a Mollie sales invoice (status='issued' -> Mollie auto-numbers).
    Carries the captured VAT/address and the e-invoice flag (ISSUE-004/005)."""
    _require_staff(auth)
    await _get_account(account_id)
    try:
        out = await billing_service.issue_sales_invoice(
            account_id,
            seats=body.seats,
            amount_eur=body.amount_eur,
            is_einvoice=body.is_einvoice,
            mark_paid=False,
        )
    except billing_service.BillingError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    logger.info("staff %s issued sales invoice for account %s", auth.user_id, account_id)
    return {"status": "ok", **out}


class MarkInvoicePaidBody(BaseModel):
    seats: Optional[int] = Field(default=None, ge=0)
    amount_eur: Optional[float] = Field(default=None, gt=0)
    is_einvoice: bool = Field(default=False)
    # Mollie requires payment details when recording an already-paid invoice.
    payment_source: str = Field(
        default="bank-transfer",
        description="How it was paid out-of-band (e.g. 'bank-transfer').",
    )
    payment_reference: Optional[str] = None


@router.post("/billing-accounts/{account_id}/mark-invoice-paid")
async def mark_invoice_paid(
    account_id: str,
    body: MarkInvoicePaidBody,
    auth: DependencyDirectusSession,
) -> dict:
    """Record an already-paid managed invoice (status='paid' with paymentDetails).
    Fits the managed flow where the buyer paid by transfer against a PO."""
    _require_staff(auth)
    await _get_account(account_id)
    payment_details: dict = {"source": body.payment_source}
    if body.payment_reference:
        payment_details["sourceReference"] = body.payment_reference
    try:
        out = await billing_service.issue_sales_invoice(
            account_id,
            seats=body.seats,
            amount_eur=body.amount_eur,
            is_einvoice=body.is_einvoice,
            mark_paid=True,
            payment_details=payment_details,
        )
    except billing_service.BillingError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    logger.info("staff %s marked invoice paid for account %s", auth.user_id, account_id)
    return {"status": "ok", **out}
