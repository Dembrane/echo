import { type Access, hasStaffPolicy, type StaffAudit } from "@dembrane/access";
import {
  BadRequestError,
  ForbiddenError,
  isUuid,
  NotFoundError,
  StatusError,
  UnauthenticatedError,
  ValidationError,
} from "@dembrane/core";
import type { Db } from "@dembrane/db";
import { type Ctx, type Env, requireUser, type Signed, v } from "@dembrane/http";
import { Hono } from "hono";
import type { Billing } from "./create";
import { orgBillingSnapshot } from "./org";
import { BillingError, billingDetailsFromAccount } from "./service";
import type { AccountRow } from "./store";

const BILLING_ROLES = ["owner", "admin", "billing"] as const;

export interface BillingRouteDeps {
  readonly db: Db;
  readonly access: Access;
  readonly staffAudit: StaffAudit;
  readonly billing: Billing;
}

type Mode = "view" | "manage";

/**
 * Billing for org owners, admins and billing members, and for staff with staff:billing
 * (audited). Workspace-scoped accounts follow the workspace's own billing policies
 * instead of org roles (spec 7 M-16): a workspace admin manages their own account, and
 * an org billing member no longer reaches a workspace that bills separately.
 */
export function billingRoutes(deps: BillingRouteDeps) {
  const { service, store } = deps.billing;

  async function staffPass(
    c: Ctx,
    who: Signed,
    action: string,
    targetType: string,
    targetId: string,
  ) {
    if (!hasStaffPolicy(who, "staff:billing")) return false;
    await deps.staffAudit.record(who, {
      permission: "staff:billing",
      action,
      targetType,
      targetId,
      requestId: c.get("requestId"),
    });
    return true;
  }

  async function requireOrgBilling(
    c: Ctx,
    orgId: string | null,
    action: string,
    target: [string, string],
  ) {
    const who = requireUser(c);
    if (await staffPass(c, who, action, target[0], target[1])) return who;
    if (!who.appUserId) throw new ForbiddenError("access.forbidden");
    if (!isUuid(orgId) || !(await store.hasOrgRole(orgId, who.appUserId, BILLING_ROLES)))
      throw new ForbiddenError("billing.role_required");
    return who;
  }

  /** Loads a live account (404 otherwise) and checks the caller may view or manage it. */
  async function account(c: Ctx, mode: Mode, action: string): Promise<AccountRow> {
    const who = c.get("principal");
    if (!who) throw new UnauthenticatedError("auth.session_expired");
    const id = c.req.param("account_id") ?? "";
    const acct = isUuid(id) ? await store.account(id) : null;
    if (!acct || acct.deleted_at) throw new NotFoundError("billing.account_not_found");
    if (!acct.org_id && acct.workspace_id) {
      if (await staffPass(c, who, action, "billing_account", acct.id)) return acct;
      if (!who.appUserId) throw new ForbiddenError("access.forbidden");
      try {
        await deps.access.workspace(
          who,
          acct.workspace_id,
          mode === "view" ? "workspace:view_invoices" : "workspace:update_payment",
        );
      } catch (e) {
        // The account exists either way; answer as the org path does, not with a 404.
        if (e instanceof NotFoundError || e instanceof ForbiddenError)
          throw new ForbiddenError("billing.role_required");
        throw e;
      }
      return acct;
    }
    await requireOrgBilling(c, acct.org_id, action, ["billing_account", acct.id]);
    return acct;
  }

  const badRequest = (e: unknown): never => {
    if (e instanceof BillingError)
      // The code's detail template may name params; the message is the text sent before.
      throw new BadRequestError(e.code as "billing.request_failed", {
        message: e.message,
        params: { reason: e.message, ...e.params },
      });
    throw e;
  };

  return new Hono<Env>()
    .get("/api/v2/orgs/:org_id/billing", async (c) => {
      const orgId = c.req.param("org_id");
      await requireOrgBilling(c, orgId, "org.billing.read", ["org", orgId]);
      return c.json(await orgBillingSnapshot(deps.db, store, orgId));
    })
    .get("/api/v2/billing-accounts/:account_id/overview", async (c) => {
      const acct = await account(c, "view", "billing_account.overview.read");
      return c.json({ account_id: acct.id, ...(await service.overview(acct.id)) });
    })
    .post("/api/v2/billing-accounts/:account_id/checkout", async (c) => {
      const raw = await v.rawRequest(c.req);
      requireUser(c);
      const { body } = v.validateRaw(raw, {
        body: {
          tier: v.literal(["innovator", "changemaker", "guardian"]),
          billing_period: v.withDefault(v.literal(["annual", "monthly"]), "annual"),
          redirect_url: v.str({ min: 1 }),
        },
      });
      const acct = await account(c, "manage", "billing_account.checkout");
      const url = await service
        .startSubscriptionCheckout(acct.id, {
          tier: body.tier,
          billingPeriod: body.billing_period,
          redirectUrl: body.redirect_url,
        })
        .catch(badRequest);
      return c.json({ checkout_url: url });
    })
    .post("/api/v2/billing-accounts/:account_id/sync", async (c) => {
      const raw = await v.rawRequest(c.req);
      requireUser(c);
      const { query } = v.validateRaw(raw, { query: { flow: v.optional(v.str()) } });
      const acct = await account(c, "manage", "billing_account.sync");
      const status = await service.syncAccount(acct.id);
      const out: Record<string, string | null> = { status };
      if (query.flow === "method")
        out.method_update = await service.latestMethodUpdateStatus(acct.id);
      return c.json(out);
    })
    .get("/api/v2/billing-accounts/:account_id/invoices", async (c) => {
      const raw = await v.rawRequest(c.req);
      requireUser(c);
      const { query } = v.validateRaw(raw, {
        query: { limit: v.withDefault(v.int({ ge: 1, le: 100 }), 20), cursor: v.optional(v.str()) },
      });
      const acct = await account(c, "view", "billing_account.invoices.read");
      return c.json(await service.listAccountInvoices(acct.id, query.limit, query.cursor));
    })
    .get("/api/v2/billing-accounts/:account_id/estimate", async (c) => {
      const acct = await account(c, "view", "billing_account.estimate.read");
      return c.json(await service.estimate(acct.id));
    })
    .get("/api/v2/billing-accounts/:account_id/billing-details", async (c) => {
      const acct = await account(c, "view", "billing_account.details.read");
      return c.json(billingDetailsFromAccount(acct));
    })
    .put("/api/v2/billing-accounts/:account_id/billing-details", async (c) => {
      const raw = await v.rawRequest(c.req);
      requireUser(c);
      const s = () => v.optional(v.str());
      const { body, bodySet } = v.validateRaw(raw, {
        body: {
          billing_legal_name: s(),
          billing_vat_id: s(),
          billing_vat_region: v.optional(v.literal(["eu", "non_eu", "international"])),
          billing_country: s(),
          billing_address_line1: s(),
          billing_address_line2: s(),
          billing_postal_code: s(),
          billing_city: s(),
        },
      });
      const acct = await account(c, "manage", "billing_account.details.update");
      // Only fields the caller sent are written, as pydantic's exclude_unset did.
      const sent = Object.fromEntries(
        Object.entries(body).filter(([k]) => bodySet.has(k)),
      ) as Record<string, string | null>;
      const saved = await service.saveBillingDetails(acct.id, sent);
      return c.json({ status: "ok", billing_details: saved });
    })
    .get("/api/v2/billing-accounts/:account_id/invoices/:invoice_id/pdf", async (c) => {
      const acct = await account(c, "view", "billing_account.invoice_pdf.read");
      const url = await service.salesInvoicePdfUrlFor(acct.id, c.req.param("invoice_id"));
      if (!url) throw new NotFoundError("billing.invoice_pdf_missing");
      return c.json({ pdf_url: url });
    })
    .post("/api/v2/billing-accounts/:account_id/cancel", async (c) => {
      const raw = await v.rawRequest(c.req);
      requireUser(c);
      const { body } = v.validateRaw(raw, {
        body: { reason: v.optional(v.str()), feedback: v.optional(v.str()) },
      });
      const acct = await account(c, "manage", "billing_account.cancel");
      const status = await service
        .cancelSubscription(acct.id, body.reason, body.feedback)
        .catch(badRequest);
      return c.json({ status });
    })
    .post("/api/v2/billing-accounts/:account_id/resume", async (c) => {
      const acct = await account(c, "manage", "billing_account.resume");
      return c.json(await service.resumeSubscription(acct.id).catch(badRequest));
    })
    .post("/api/v2/billing-accounts/:account_id/payment-method/checkout", async (c) => {
      const raw = await v.rawRequest(c.req);
      requireUser(c);
      const { body } = v.validateRaw(raw, { body: { redirect_url: v.str({ min: 1 }) } });
      const acct = await account(c, "manage", "billing_account.payment_method.update");
      const url = await service
        .startUpdatePaymentMethod(acct.id, body.redirect_url)
        .catch(badRequest);
      return c.json({ checkout_url: url });
    })
    .post("/api/v2/billing-accounts/:account_id/retry-charge", async (c) => {
      const acct = await account(c, "manage", "billing_account.retry_charge");
      return c.json({ status: await service.retryCharge(acct.id) });
    });
}

/** The Mollie webhook: public, trusted only through the re-fetch of the payment. */
export function mollieWebhookRoutes(deps: Pick<BillingRouteDeps, "billing">) {
  return new Hono<Env>().post("/api/v2/billing/mollie/webhook", async (c) => {
    const type = c.req.header("content-type") ?? "";
    let id: unknown;
    if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data"))
      id = (await c.req.parseBody()).id;
    if (typeof id !== "string")
      throw new ValidationError("validation.invalid_input", {
        details: [
          {
            type: "missing",
            loc: ["body", "id"],
            msg: "Field required",
            input: null,
            url: "https://errors.pydantic.dev/2.12/v/missing",
          },
        ],
        params: {
          fields: [{ field: "id", loc: ["body", "id"], code: "field.required", params: {} }],
        },
      });
    try {
      await deps.billing.service.handleWebhook(id);
    } catch (err) {
      // 500 makes Mollie retry; the handler is idempotent.
      c.get("logger")?.error({ err, paymentId: id }, "mollie webhook processing failed");
      throw new StatusError(500, "billing.webhook_failed");
    }
    return c.json({ status: "ok" });
  });
}
