"""Billing endpoints: self-serve checkout + the Mollie webhook.

- POST /v2/billing-accounts/{account_id}/checkout — org admin/owner/billing (or
  staff) starts a subscription; returns the Mollie hosted checkout URL.
- POST /v2/billing/mollie/webhook — public. Mollie POSTs a payment id; we
  re-fetch and reconcile. No auth (Mollie can't carry our session); the handler
  re-fetches from Mollie so a spoofed id only triggers a harmless lookup.
"""

from __future__ import annotations

from typing import Literal, Optional
from logging import getLogger

from fastapi import Form, APIRouter, HTTPException
from pydantic import Field, BaseModel

from dembrane import billing_service
from dembrane.app_user import resolve_app_user
from dembrane.directus_async import async_directus
from dembrane.billing_account import get_org_account_id
from dembrane.api.dependency_auth import DependencyDirectusSession

router = APIRouter()
webhook_router = APIRouter()
logger = getLogger("api.v2.billing")

_BILLING_ROLES = ("owner", "admin", "billing")


class CheckoutBody(BaseModel):
    tier: Literal["innovator", "changemaker", "guardian"]
    billing_period: Literal["annual", "monthly"] = "annual"
    redirect_url: str = Field(min_length=1)


async def _account_org_id(account: dict) -> Optional[str]:
    if account.get("org_id"):
        return account["org_id"]
    workspace_id = account.get("workspace_id")
    if workspace_id:
        ws = await async_directus.get_item("workspace", workspace_id)
        return (ws or {}).get("org_id")
    return None


async def _has_billing_role(org_id: Optional[str], app_user_id: str) -> bool:
    if not org_id:
        return False
    rows = await async_directus.get_items(
        "org_membership",
        {
            "query": {
                "filter": {
                    "user_id": {"_eq": app_user_id},
                    "org_id": {"_eq": org_id},
                    "role": {"_in": list(_BILLING_ROLES)},
                    "deleted_at": {"_null": True},
                },
                "fields": ["id"],
                "limit": 1,
            }
        },
    )
    return isinstance(rows, list) and bool(rows)


async def _require_org_billing_access(org_id: Optional[str], auth: DependencyDirectusSession) -> None:
    """Staff, or an owner/admin/billing member of the org. Raises 403."""
    if auth.is_admin:
        return
    app_user = await resolve_app_user(auth.user_id)
    if not app_user:
        raise HTTPException(status_code=403, detail="Not allowed")
    if not await _has_billing_role(org_id, app_user["id"]):
        raise HTTPException(
            status_code=403,
            detail="You must be an organisation owner, admin, or billing role.",
        )


async def _require_billing_access(account: dict, auth: DependencyDirectusSession) -> None:
    """Staff, or an owner/admin/billing member of the account's org. Raises 403."""
    await _require_org_billing_access(await _account_org_id(account), auth)


@router.get("/orgs/{org_id}/billing")
async def org_billing(org_id: str, auth: DependencyDirectusSession) -> dict:
    """The org's billing account snapshot for the org billing page: plan,
    payment status, cadence, and current seat count. Returns a Free shell when
    the org has no account yet."""
    await _require_org_billing_access(org_id, auth)
    account_id = await get_org_account_id(org_id)
    if not account_id:
        return {
            "account_id": None,
            "tier": "free",
            "status": None,
            "billing_period": None,
            "seats": 0,
        }
    account = await async_directus.get_item("billing_account", account_id)
    seats = await billing_service.count_account_seats(account_id)
    return {
        "account_id": account_id,
        "tier": (account or {}).get("tier") or "free",
        "status": (account or {}).get("status"),
        "billing_period": (account or {}).get("billing_period"),
        "seats": seats,
    }


@router.post("/billing-accounts/{account_id}/checkout")
async def start_checkout(
    account_id: str,
    body: CheckoutBody,
    auth: DependencyDirectusSession,
) -> dict:
    """Start a subscription on a billing account; returns the checkout URL."""
    account = await async_directus.get_item("billing_account", account_id)
    if not account or account.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Billing account not found")
    await _require_billing_access(account, auth)

    try:
        url = await billing_service.start_subscription_checkout(
            account_id,
            tier=body.tier,
            billing_period=body.billing_period,
            redirect_url=body.redirect_url,
        )
    except billing_service.BillingError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"checkout_url": url}


@router.post("/billing-accounts/{account_id}/sync")
async def sync_account(account_id: str, auth: DependencyDirectusSession) -> dict:
    """Reconcile an account from Mollie (called on return from checkout, or as a
    catch-up). Activates if a first payment cleared without a webhook."""
    account = await async_directus.get_item("billing_account", account_id)
    if not account or account.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Billing account not found")
    await _require_billing_access(account, auth)
    status = await billing_service.sync_account_from_mollie(account_id)
    return {"status": status}


@router.get("/billing-accounts/{account_id}/invoices")
async def list_invoices(account_id: str, auth: DependencyDirectusSession) -> dict:
    """Payment history for the account (in-app invoice list)."""
    account = await async_directus.get_item("billing_account", account_id)
    if not account or account.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Billing account not found")
    await _require_billing_access(account, auth)
    return {"invoices": await billing_service.list_account_invoices(account_id)}


@router.get("/billing-accounts/{account_id}/estimate")
async def estimate_cost(account_id: str, auth: DependencyDirectusSession) -> dict:
    """Per-tier cost preview at the account's current seat count (cost-to-move)."""
    account = await async_directus.get_item("billing_account", account_id)
    if not account or account.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Billing account not found")
    await _require_billing_access(account, auth)
    return await billing_service.estimate_account_cost(account_id)


class CancelBody(BaseModel):
    # Survey: why are they leaving? Stored on the account + emitted to PostHog
    # from the client. Optional so a cancel never blocks on the survey.
    reason: Optional[str] = None
    feedback: Optional[str] = None


@router.post("/billing-accounts/{account_id}/cancel")
async def cancel_subscription(
    account_id: str,
    body: CancelBody,
    auth: DependencyDirectusSession,
) -> dict:
    """Cancel the account's Mollie subscription and revert to Free.

    Stops future charges immediately. The cancellation reason is captured for
    the team (churn survey). Idempotent: cancelling an already-free account is
    a no-op."""
    account = await async_directus.get_item("billing_account", account_id)
    if not account or account.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Billing account not found")
    await _require_billing_access(account, auth)
    try:
        status = await billing_service.cancel_subscription(
            account_id, reason=body.reason, feedback=body.feedback
        )
    except billing_service.BillingError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": status}


@webhook_router.post("/mollie/webhook")
async def mollie_webhook(id: str = Form(...)) -> dict:
    """Mollie payment webhook. Re-fetches the payment and reconciles the account.
    Returns 500 on failure so Mollie retries (the handler is idempotent)."""
    try:
        await billing_service.handle_mollie_webhook(id)
    except Exception as exc:
        logger.exception("Mollie webhook processing failed for payment %s", id)
        raise HTTPException(status_code=500, detail="webhook processing failed") from exc
    return {"status": "ok"}
