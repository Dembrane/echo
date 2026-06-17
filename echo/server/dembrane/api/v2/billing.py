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

    if not auth.is_admin:
        app_user = await resolve_app_user(auth.user_id)
        if not app_user:
            raise HTTPException(status_code=403, detail="Not allowed")
        org_id = await _account_org_id(account)
        rows = await async_directus.get_items(
            "org_membership",
            {
                "query": {
                    "filter": {
                        "user_id": {"_eq": app_user["id"]},
                        "org_id": {"_eq": org_id},
                        "role": {"_in": list(_BILLING_ROLES)},
                        "deleted_at": {"_null": True},
                    },
                    "fields": ["id"],
                    "limit": 1,
                }
            },
        )
        if not isinstance(rows, list) or not rows:
            raise HTTPException(
                status_code=403,
                detail="You must be an organisation owner, admin, or billing role.",
            )

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
