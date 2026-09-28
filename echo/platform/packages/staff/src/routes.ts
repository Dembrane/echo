import { requireStaff, type StaffAudit, type StaffPolicy } from "@dembrane/access";
import {
  type Billing,
  BillingError,
  directusTime,
  isUuid,
  dashboardUrl as molliePaymentDashboardUrl,
  pyIso,
  str,
  TIER_CAPACITIES,
} from "@dembrane/billing";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, newId } from "@dembrane/core";
import type { Db } from "@dembrane/db";
import { type Ctx, type Env, requireUser, v } from "@dembrane/http";
import type { Mailer } from "@dembrane/mail";
import type { Logger } from "@dembrane/observability";
import { Hono } from "hono";
import { atRisk, billingRollup } from "./rollup";
import { cancelPendingTasks, SUPPORT_TASKS, scheduleTask } from "./scheduled";
import { staffStorage } from "./storage";
import { EVENTS, membershipExpired, REQUEST_TTL_MS, SupportAccess } from "./support";

export interface StaffRouteDeps {
  readonly db: Db;
  readonly staffAudit: StaffAudit;
  readonly billing: Billing;
  readonly mailer: Mailer;
  readonly logger: Logger;
  readonly config: { readonly http: { readonly dashboardUrl: string } };
  readonly clock?: () => Date;
}

const MOLLIE_DASHBOARD_LIVE = "https://www.mollie.com/dashboard/payments";
const MOLLIE_DASHBOARD_TEST = "https://www.mollie.com/dashboard/org_test/payments";
const STAFF_EMAIL_DOMAIN = "@dembrane.com";

/**
 * The staff console (old admin.py and admin_managed.py). Every route needs a named
 * staff permission and records its use; the old blanket is_admin check is gone.
 */
export function staffRoutes(deps: StaffRouteDeps) {
  const s = staffStorage(deps.db);
  const clock = deps.clock ?? (() => new Date());
  const { service: billing, store: billingStore, notifier } = deps.billing;
  const support = new SupportAccess({
    db: deps.db,
    storage: s,
    billingStore,
    notifier,
    mailer: deps.mailer,
    logger: deps.logger,
    dashboardUrl: deps.config.http.dashboardUrl,
    clock,
  });

  async function staff(
    c: Ctx,
    permission: StaffPolicy,
    action: string,
    target?: [string, string],
    detail?: Record<string, unknown>,
  ) {
    const who = requireUser(c);
    await requireStaff(deps.staffAudit, who, {
      permission,
      action,
      ...(target && { targetType: target[0], targetId: target[1] }),
      ...(detail && { detail }),
      requestId: c.get("requestId"),
    });
    return who;
  }

  /** The caller's app_user; staff act on customer workspaces as themselves. */
  async function appUser(directusUserId: string) {
    const u = await s.appUserByDirectusId(directusUserId);
    if (!u) throw new ForbiddenError("User not onboarded");
    return u;
  }

  async function liveWorkspace(id: string) {
    const ws = isUuid(id) ? await s.workspace(id) : null;
    if (!ws || ws.deleted_at) throw new NotFoundError("Workspace not found");
    return ws;
  }

  async function liveAccount(id: string) {
    const acc = isUuid(id) ? await billingStore.account(id) : null;
    if (!acc || acc.deleted_at) throw new NotFoundError("Billing account not found");
    return acc;
  }

  async function accountManager(appUserId: string) {
    const user = isUuid(appUserId) ? await billingStore.appUser(appUserId) : null;
    if (!user) throw new BadRequestError("Account manager user not found");
    if (!(user.email ?? "").trim().toLowerCase().endsWith(STAFF_EMAIL_DOMAIN))
      throw new BadRequestError("Account manager must be a dembrane staff member (@dembrane.com).");
    return user;
  }

  const billingBad = (e: unknown): never => {
    if (e instanceof BillingError) throw new BadRequestError(e.message);
    throw e;
  };

  const discountBody = {
    type_discount: v.optional(v.literal(["scholarship", "staff_discount"])),
    percent_discount: v.optional(v.int({ ge: 0, le: 100 })),
    clear_type_discount: v.withDefault(v.bool(), false),
    clear_percent_discount: v.withDefault(v.bool(), false),
  };

  function discountPatch(b: {
    type_discount: string | null;
    percent_discount: number | null;
    clear_type_discount: boolean;
    clear_percent_discount: boolean;
  }) {
    const patch: { type_discount?: string | null; percent_discount?: number | null } = {};
    if (b.clear_type_discount) patch.type_discount = null;
    else if (b.type_discount !== null) patch.type_discount = b.type_discount;
    if (b.clear_percent_discount) patch.percent_discount = null;
    else if (b.percent_discount !== null) patch.percent_discount = b.percent_discount;
    if (!Object.keys(patch).length) throw new BadRequestError("Nothing to update");
    return patch;
  }

  const app = new Hono<Env>();
  const A = "/api/v2/admin";

  // ── Read-only rollups ────────────────────────────────────────────────
  app.get(`${A}/billing-rollup`, async (c) => {
    const raw = await v.rawRequest(c.req);
    requireUser(c);
    const { query } = v.validateRaw(raw, {
      query: { month_offset: v.withDefault(v.int({ ge: -12, le: 0 }), 0) },
    });
    await staff(c, "staff:billing", "admin.billing_rollup.read", undefined, {
      month_offset: query.month_offset,
    });
    return c.json(await billingRollup(s, clock(), query.month_offset));
  });

  app.get(`${A}/at-risk`, async (c) => {
    await staff(c, "staff:billing", "admin.at_risk.read");
    return c.json(await atRisk(s, clock()));
  });

  app.get(`${A}/referral-ledger`, async (c) => {
    await staff(c, "staff:billing", "admin.referral_ledger.read");
    const rows = await s.referralLedger();
    const wsNames = new Map(
      (await s.workspaceNames(rows.map((r) => r.workspace_id))).map((w) => [w.id, w.name ?? ""]),
    );
    const orgNames = new Map(
      (await s.orgs(rows.map((r) => r.partner_team_id))).map((o) => [o.id, o.name ?? ""]),
    );
    return c.json(
      rows.map((r) => ({
        id: String(r.id),
        workspace_id: r.workspace_id,
        workspace_name: wsNames.get(r.workspace_id) ?? null,
        partner_team_id: r.partner_team_id,
        partner_team_name: orgNames.get(r.partner_team_id) ?? null,
        // The ledger has no source org, customer discount or kickback cap columns.
        from_org_id: null,
        from_org_name: null,
        partner_kickback_percent: r.partner_kickback_percent,
        to_organisation_discount_percent: null,
        eur_cap_kickback: null,
        starts_at: directusTime(r.starts_at),
        expires_at: directusTime(r.expires_at),
        notes: r.notes,
      })),
    );
  });

  app.get(`${A}/external-led-orgs`, async (c) => {
    await staff(c, "staff:billing", "admin.external_led_orgs.read");
    const ext = await s.externalMemberships();
    if (!ext.length) return c.json([]);
    const wsToOrg = new Map(
      (await s.workspaceNames(ext.map((m) => m.workspace_id))).map((w) => [w.id, w.org_id]),
    );
    const partners = new Map(
      (await s.partnerOrgs([...new Set(wsToOrg.values())])).map((o) => [o.id, o.name ?? ""]),
    );
    const userToPartners = new Map<string, Set<string>>();
    for (const m of ext) {
      const oid = wsToOrg.get(m.workspace_id);
      if (!oid || !partners.has(oid)) continue;
      const set = userToPartners.get(m.user_id) ?? new Set<string>();
      set.add(partners.get(oid) as string);
      userToPartners.set(m.user_id, set);
    }
    if (!userToPartners.size) return c.json([]);
    const created = await s.orgsCreatedBy([...userToPartners.keys()]);
    if (!created.length) return c.json([]);
    const users = new Map(
      (await s.appUsers(created.map((o) => o.created_by as string))).map((u) => [u.id, u]),
    );
    return c.json(
      created.map((o) => {
        const u = users.get(o.created_by ?? "");
        return {
          org_id: o.id,
          org_name: o.name ?? "",
          created_at: directusTime(o.created_at),
          creator_user_id: o.created_by,
          creator_email: u?.email ?? null,
          creator_name: u?.display_name ?? null,
          partner_org_names: [...(userToPartners.get(o.created_by ?? "") ?? [])].sort(),
        };
      }),
    );
  });

  app.get(`${A}/payments`, async (c) => {
    const raw = await v.rawRequest(c.req);
    requireUser(c);
    const { query } = v.validateRaw(raw, {
      query: { per_account: v.withDefault(v.int({ ge: 1, le: 50 }), 10) },
    });
    await staff(c, "staff:billing", "admin.payments.read");
    const mollie = deps.billing.mollie;
    const accounts = await s.accountsWithCustomer();
    const orgNames = new Map(
      (await s.orgs(accounts.map((a) => a.org_id).filter((x): x is string => Boolean(x)))).map(
        (o) => [o.id, o.name ?? ""],
      ),
    );
    const rows: Record<string, unknown>[] = [];
    let paid = 0;
    let failed = 0;
    let open = 0;
    if (mollie.enabled)
      for (const a of accounts) {
        let payments: Awaited<ReturnType<typeof mollie.listCustomerPayments>>;
        try {
          payments = await mollie.listCustomerPayments(a.mollie_customer_id as string, {
            limit: query.per_account,
          });
        } catch {
          // One bad customer must not sink the whole rollup.
          continue;
        }
        for (const p of payments) {
          const amt = (p.amount ?? {}) as { value?: string; currency?: string };
          const status = str(p.status);
          if (status === "paid") {
            const n = Number(amt.value);
            if (amt.value !== undefined && !Number.isNaN(n)) paid += n;
          } else if (status && ["failed", "expired", "canceled"].includes(status)) failed += 1;
          else if (status === "open" || status === "pending") open += 1;
          rows.push({
            payment_id: String(p.id),
            billing_account_id: a.id,
            account_label: a.label,
            org_id: a.org_id,
            org_name: orgNames.get(a.org_id ?? "") ?? null,
            tier: a.tier,
            created_at: p.createdAt ?? null,
            amount: amt.value ?? null,
            currency: amt.currency || "EUR",
            status,
            sequence_type: p.sequenceType ?? null,
            method: p.method ?? null,
            description: str(p.description) || "",
            dashboard_url: molliePaymentDashboardUrl(p),
          });
        }
      }
    rows.sort((x, y) => String(y.created_at ?? "").localeCompare(String(x.created_at ?? "")));
    return c.json({
      mollie_enabled: mollie.enabled,
      mollie_test_mode: mollie.testMode,
      mollie_dashboard_url: mollie.testMode ? MOLLIE_DASHBOARD_TEST : MOLLIE_DASHBOARD_LIVE,
      accounts_with_customer: accounts.length,
      payment_count: rows.length,
      paid_eur: Math.round(paid * 100) / 100,
      failed_count: failed,
      open_count: open,
      rows,
    });
  });

  // ── Discounts, partner flag, trials ──────────────────────────────────
  app.patch(`${A}/workspaces/:workspace_id/discount`, async (c) => {
    const raw = await v.rawRequest(c.req);
    requireUser(c);
    const { body } = v.validateRaw(raw, { body: discountBody });
    const id = c.req.param("workspace_id");
    await staff(c, "staff:billing", "workspace.discount.update", ["workspace", id], body);
    const ws = await liveWorkspace(id);
    const patch = discountPatch(body);
    // Discounts live on the billing account; the workspace has no discount columns.
    await billingStore.updateAccount(ws.billing_account_id, patch, clock());
    return c.json({ status: "ok", ...patch });
  });

  app.patch(`${A}/billing-accounts/:account_id/discount`, async (c) => {
    const raw = await v.rawRequest(c.req);
    requireUser(c);
    const { body } = v.validateRaw(raw, { body: discountBody });
    const id = c.req.param("account_id");
    await staff(
      c,
      "staff:billing",
      "billing_account.discount.update",
      ["billing_account", id],
      body,
    );
    const acc = await liveAccount(id);
    const patch = discountPatch(body);
    await billingStore.updateAccount(acc.id, patch, clock());
    return c.json({ status: "ok", ...patch, account_id: acc.id });
  });

  app.patch(`${A}/orgs/:org_id/partner`, async (c) => {
    const raw = await v.rawRequest(c.req);
    requireUser(c);
    const { body } = v.validateRaw(raw, { body: { is_partner: v.bool() } });
    const id = c.req.param("org_id");
    await staff(c, "staff:workspaces", "org.partner.update", ["org", id], body);
    const org = isUuid(id) ? await s.org(id) : null;
    if (!org || org.deleted_at) throw new NotFoundError("Organisation not found");
    await s.updateOrg(id, { is_partner: body.is_partner }, clock());
    return c.json({ status: "ok", org_id: id, is_partner: body.is_partner });
  });

  app.post(`${A}/billing-accounts/:account_id/grant-trial`, async (c) => {
    const raw = await v.rawRequest(c.req);
    requireUser(c);
    const { body } = v.validateRaw(raw, {
      body: {
        tier: v.withDefault(v.literal(["innovator", "changemaker", "guardian"]), "changemaker"),
        months: v.withDefault(v.int({ ge: 1, le: 12 }), 1),
      },
    });
    const id = c.req.param("account_id");
    await staff(c, "staff:set_tier", "billing_account.trial.grant", ["billing_account", id], body);
    await liveAccount(id);
    const now = clock();
    const expires = pyIso(new Date(now.getTime() + 30 * body.months * 86_400_000));
    await billingStore.updateAccount(
      id,
      {
        tier: body.tier,
        tier_expires_at: expires,
        pre_warning_sent: false,
        type_discount: "trial",
        payment_mode: "none",
        downgraded_at: null,
        downgraded_from_tier: null,
      },
      now,
    );
    return c.json({
      status: "ok",
      billing_account_id: id,
      tier: body.tier,
      tier_expires_at: expires,
    });
  });

  // ── Workspace controls ───────────────────────────────────────────────
  app.get(`${A}/workspaces/:workspace_id/members`, async (c) => {
    const id = c.req.param("workspace_id");
    await staff(c, "staff:workspaces", "workspace.members.read", ["workspace", id]);
    if (!isUuid(id)) return c.json([]);
    const mems = await s.workspaceMemberships(id);
    const users = new Map((await s.appUsers(mems.map((m) => m.user_id))).map((u) => [u.id, u]));
    return c.json(
      mems.map((m) => ({
        membership_id: m.id,
        user_id: m.user_id,
        display_name: users.get(m.user_id)?.display_name ?? null,
        email: users.get(m.user_id)?.email ?? null,
        role: m.role,
      })),
    );
  });

  app.post(`${A}/workspaces/:workspace_id/change-admin`, async (c) => {
    const raw = await v.rawRequest(c.req);
    requireUser(c);
    const { body } = v.validateRaw(raw, { body: { membership_id: v.str() } });
    const id = c.req.param("workspace_id");
    await staff(c, "staff:workspaces", "workspace.admin.change", ["workspace", id], body);
    await liveWorkspace(id);
    const m = isUuid(body.membership_id) ? await s.membership(body.membership_id) : null;
    if (!m || m.deleted_at || m.workspace_id !== id)
      throw new NotFoundError("Membership not found in this workspace");
    if (m.role === "external" || m.role === "observer")
      throw new BadRequestError(
        "Cannot promote an outside collaborator to admin. Add them to the org first.",
      );
    if (m.role !== "admin" && m.role !== "owner")
      await s.updateMembership(m.id, { role: "admin" }, clock());
    return c.json({
      status: "ok",
      workspace_id: id,
      membership_id: body.membership_id,
      role: "admin",
    });
  });

  app.post(`${A}/workspaces/:workspace_id/reset-usage`, async (c) => {
    const raw = await v.rawRequest(c.req);
    requireUser(c);
    const { body } = v.validateRaw(raw, { body: { reason: v.str({ min: 1, max: 500 }) } });
    const id = c.req.param("workspace_id");
    const who = await staff(
      c,
      "staff:workspaces",
      "workspace.usage.reset",
      ["workspace", id],
      body,
    );
    const ws = await liveWorkspace(id);
    const now = clock();
    const nowIso = pyIso(now);
    const settings = {
      ...((ws.settings ?? {}) as Record<string, unknown>),
      usage_reset_at: nowIso,
      usage_reset_by: who.directusUserId,
      usage_reset_reason: body.reason,
    };
    await s.updateWorkspace(id, { settings }, now);
    return c.json({ status: "ok", workspace_id: id, usage_reset_at: nowIso });
  });

  // ── Support access ───────────────────────────────────────────────────
  app.post(`${A}/workspaces/:workspace_id/join-support`, async (c) => {
    const id = c.req.param("workspace_id");
    const who = await staff(c, "staff:support_join", "workspace.support.join", ["workspace", id]);
    const ws = await liveWorkspace(id);
    if (!ws.allow_support_access)
      throw new ForbiddenError("This workspace has not enabled dembrane staff support access.");
    const me = await appUser(who.directusUserId);
    const g = await support.grant(id, me.id, ws.org_id);
    if (g.status !== "already_member")
      await support.record({
        workspaceId: id,
        eventCode: g.status === "joined" ? EVENTS.staffJoined : EVENTS.staffExtended,
        actorUserId: me.id,
        staffUserId: me.id,
        params: { membership_id: g.membershipId, expires_at: g.expiresIso },
      });
    let role = "admin";
    if (g.status === "already_member") role = (await s.membership(g.membershipId))?.role ?? "";
    return c.json({
      status: g.status,
      workspace_id: id,
      membership_id: g.membershipId,
      role,
      expires_at: g.expiresIso,
    });
  });

  app.get(`${A}/workspaces/:workspace_id/join-support`, async (c) => {
    const id = c.req.param("workspace_id");
    const who = await staff(c, "staff:support_join", "workspace.support.read", ["workspace", id]);
    const me = await appUser(who.directusUserId);
    const now = clock();
    const live = isUuid(id)
      ? (await s.supportRows(id, me.id)).filter((r) => !membershipExpired(r.expires_at, now))
      : [];
    if (!live.length) return c.json({ active: false, membership_id: null, expires_at: null });
    const row = live.reduce((a, b) =>
      String(b.expires_at ?? "") > String(a.expires_at ?? "") ? b : a,
    );
    return c.json({
      active: true,
      membership_id: row.id,
      expires_at: directusTime(row.expires_at),
    });
  });

  app.delete(`${A}/workspaces/:workspace_id/join-support`, async (c) => {
    const id = c.req.param("workspace_id");
    const who = await staff(c, "staff:support_join", "workspace.support.leave", ["workspace", id]);
    const me = await appUser(who.directusUserId);
    const rows = isUuid(id) ? await s.supportRows(id, me.id) : [];
    const inactive = { active: false, membership_id: null, expires_at: null };
    if (!rows.length) return c.json(inactive);
    const now = clock();
    for (const r of rows) {
      await s.updateMembership(r.id, { deleted_at: pyIso(now) }, now);
      await cancelPendingTasks(
        deps.db,
        SUPPORT_TASKS.revokeStaffSupport,
        { membership_id: r.id },
        now,
      );
    }
    for (const r of rows)
      await support.record({
        workspaceId: id,
        eventCode: EVENTS.staffLeft,
        actorUserId: me.id,
        staffUserId: me.id,
        params: { membership_id: r.id },
        notify: false,
      });
    if (!(await support.maybeAutoDisable(id)))
      await support.notice(id, EVENTS.staffLeft, null, me.id, {});
    return c.json(inactive);
  });

  const requestOut = (r: {
    id: string;
    workspace_id: string | null;
    status: string | null;
    message: string | null;
    created_at: string | null;
    expires_at: string | null;
  }) => ({
    id: r.id,
    workspace_id: r.workspace_id ?? "",
    status: r.status ?? "",
    message: r.message,
    created_at: directusTime(r.created_at),
    expires_at: directusTime(r.expires_at),
  });

  app.post(`${A}/workspaces/:workspace_id/support-access/request`, async (c) => {
    const raw = await v.rawRequest(c.req);
    requireUser(c);
    const { body } = v.validateRaw(raw, { body: { message: v.optional(v.str()) } });
    const id = c.req.param("workspace_id");
    const who = await staff(c, "staff:support_join", "workspace.support.request", [
      "workspace",
      id,
    ]);
    const ws = await liveWorkspace(id);
    if (ws.allow_support_access)
      throw new ConflictError("Support access is already on for this workspace; join directly.");
    const me = await appUser(who.directusUserId);
    const [existing] = await s.ownRequests(id, me.id, "pending");
    if (existing) return c.json(requestOut(existing));
    const now = clock();
    const expires = new Date(now.getTime() + REQUEST_TTL_MS);
    const message = [...(body.message ?? "").trim()].slice(0, 2000).join("") || null;
    const row = {
      id: newId(),
      workspace_id: id,
      requested_by: me.id,
      status: "pending",
      message,
      created_at: pyIso(now),
      expires_at: pyIso(expires),
    };
    await s.insertRequest(row);
    await scheduleTask(
      deps.db,
      SUPPORT_TASKS.expireSupportRequest,
      expires,
      { request_id: row.id, workspace_id: id },
      now,
    );
    await support.record({
      workspaceId: id,
      eventCode: EVENTS.requestCreated,
      actorUserId: me.id,
      staffUserId: me.id,
      params: { request_id: row.id, message },
    });
    // The old route answered with the object it just built, so its timestamps keep Python's
    // isoformat; a request read back from the database answers in Directus's form.
    return c.json({ ...requestOut(row), created_at: row.created_at, expires_at: row.expires_at });
  });

  app.get(`${A}/workspaces/:workspace_id/support-access/request`, async (c) => {
    const id = c.req.param("workspace_id");
    const who = await staff(c, "staff:support_join", "workspace.support_request.read", [
      "workspace",
      id,
    ]);
    const ws = await liveWorkspace(id);
    const me = await appUser(who.directusUserId);
    const [latest] = await s.ownRequests(id, me.id);
    return c.json({
      support_access_enabled: ws.allow_support_access,
      request: latest ? requestOut(latest) : null,
    });
  });

  app.delete(`${A}/workspaces/:workspace_id/support-access/request`, async (c) => {
    const id = c.req.param("workspace_id");
    const who = await staff(c, "staff:support_join", "workspace.support_request.cancel", [
      "workspace",
      id,
    ]);
    const ws = await liveWorkspace(id);
    const me = await appUser(who.directusUserId);
    const [pending] = await s.ownRequests(id, me.id, "pending");
    if (pending) {
      const now = clock();
      await s.updateRequest(pending.id, {
        status: "cancelled",
        resolved_at: pyIso(now),
        resolved_by: me.id,
      });
      await cancelPendingTasks(
        deps.db,
        SUPPORT_TASKS.expireSupportRequest,
        { request_id: pending.id },
        now,
      );
      await support.record({
        workspaceId: id,
        eventCode: EVENTS.requestCancelled,
        actorUserId: me.id,
        staffUserId: me.id,
        params: { request_id: pending.id, reason: "withdrawn" },
        notify: false,
      });
    }
    const [latest] = await s.ownRequests(id, me.id);
    return c.json({
      support_access_enabled: ws.allow_support_access,
      request: latest ? requestOut(latest) : null,
    });
  });

  // ── Managed billing (admin_managed.py) ──────────────────────────────
  app.post(`${A}/billing-accounts/:account_id/set-managed`, async (c) => {
    const raw = await v.rawRequest(c.req);
    requireUser(c);
    const { body } = v.validateRaw(raw, {
      body: {
        // Known tiers only: a legacy tier string would switch paid features off (spec 7 L-17).
        tier: v.literal(Object.keys(TIER_CAPACITIES)),
        seats: v.optional(v.int({ ge: 0 })),
        account_manager_id: v.optional(v.str()),
      },
    });
    const id = c.req.param("account_id");
    await staff(c, "staff:set_tier", "billing_account.managed.set", ["billing_account", id], body);
    const acc = await liveAccount(id);
    if (acc.payment_mode === "mollie" && acc.mollie_subscription_id)
      throw new ConflictError(
        "This account has an active subscription. Ask the customer to cancel it from their billing page first.",
      );
    const patch: Parameters<typeof billingStore.updateAccount>[1] = {
      payment_mode: "offline",
      tier: body.tier,
      status: "active",
      tier_expires_at: null,
      pre_warning_sent: false,
    };
    if (body.seats !== null) patch.provisioned_seats = body.seats;
    if (body.account_manager_id !== null) {
      await accountManager(body.account_manager_id);
      patch.account_manager_id = body.account_manager_id;
    }
    await billingStore.updateAccount(id, patch, clock());
    return c.json({ status: "ok", billing_account_id: id, payment_mode: "offline" });
  });

  app.post(`${A}/billing-accounts/:account_id/set-saas`, async (c) => {
    const raw = await v.rawRequest(c.req);
    requireUser(c);
    const { body } = v.validateRaw(raw, {
      body: { to_free: v.bool(), expires_at: v.optional(v.str()) },
    });
    const id = c.req.param("account_id");
    await staff(c, "staff:set_tier", "billing_account.saas.set", ["billing_account", id], body);
    const acc = await liveAccount(id);
    if (acc.payment_mode === "mollie")
      throw new BadRequestError("Account already bills through Mollie.");
    if (acc.payment_mode !== "offline") throw new BadRequestError("Account is not managed.");
    if (!body.to_free && !body.expires_at)
      throw new BadRequestError("An expiry date is required when keeping the tier.");
    await billingStore.updateAccount(
      id,
      body.to_free
        ? { payment_mode: "none", tier: "free", status: "active", tier_expires_at: null }
        : {
            payment_mode: "none",
            tier_expires_at: body.expires_at,
            status: "active",
            pre_warning_sent: false,
          },
      clock(),
    );
    return c.json({ status: "ok", billing_account_id: id, payment_mode: "none" });
  });

  app.post(`${A}/billing-accounts/:account_id/account-manager`, async (c) => {
    const raw = await v.rawRequest(c.req);
    requireUser(c);
    const { body } = v.validateRaw(raw, { body: { account_manager_id: v.str() } });
    const id = c.req.param("account_id");
    await staff(
      c,
      "staff:billing",
      "billing_account.manager.assign",
      ["billing_account", id],
      body,
    );
    await liveAccount(id);
    const user = await accountManager(body.account_manager_id);
    await billingStore.updateAccount(id, { account_manager_id: body.account_manager_id }, clock());
    return c.json({
      status: "ok",
      account_manager: { name: user.display_name || user.email, email: user.email },
    });
  });

  app.delete(`${A}/billing-accounts/:account_id/account-manager`, async (c) => {
    const id = c.req.param("account_id");
    await staff(c, "staff:billing", "billing_account.manager.clear", ["billing_account", id]);
    await liveAccount(id);
    await billingStore.updateAccount(id, { account_manager_id: null }, clock());
    return c.json({ status: "ok" });
  });

  app.post(`${A}/billing-accounts/:account_id/issue-payment-link`, async (c) => {
    const raw = await v.rawRequest(c.req);
    requireUser(c);
    const { body } = v.validateRaw(raw, {
      body: {
        amount_eur: v.optional(v.num({ gt: 0 })),
        description: v.optional(v.str()),
        redirect_url: v.optional(v.str()),
      },
    });
    const id = c.req.param("account_id");
    await staff(
      c,
      "staff:billing",
      "billing_account.payment_link.issue",
      ["billing_account", id],
      body,
    );
    await liveAccount(id);
    const out = await billing
      .issueOfflinePaymentLink(id, {
        amountEur: body.amount_eur,
        description: body.description,
        redirectUrl: body.redirect_url,
      })
      .catch(billingBad);
    // The invoice's own status replaces "ok", as the old dict merge did.
    return c.json(Object.assign({ status: "ok" }, out));
  });

  app.post(`${A}/billing-accounts/:account_id/issue-invoice`, async (c) => {
    const raw = await v.rawRequest(c.req);
    requireUser(c);
    const { body } = v.validateRaw(raw, {
      body: {
        seats: v.optional(v.int({ ge: 0 })),
        amount_eur: v.optional(v.num({ gt: 0 })),
        is_einvoice: v.withDefault(v.bool(), false),
      },
    });
    const id = c.req.param("account_id");
    await staff(c, "staff:billing", "billing_account.invoice.issue", ["billing_account", id], body);
    await liveAccount(id);
    const out = await billing
      .issueSalesInvoice(id, {
        seats: body.seats,
        amountEur: body.amount_eur,
        isEInvoice: body.is_einvoice,
        markPaid: false,
      })
      .catch(billingBad);
    // The invoice's own status replaces "ok", as the old dict merge did.
    return c.json(Object.assign({ status: "ok" }, out));
  });

  app.post(`${A}/billing-accounts/:account_id/mark-invoice-paid`, async (c) => {
    const raw = await v.rawRequest(c.req);
    requireUser(c);
    const { body } = v.validateRaw(raw, {
      body: {
        seats: v.optional(v.int({ ge: 0 })),
        amount_eur: v.optional(v.num({ gt: 0 })),
        is_einvoice: v.withDefault(v.bool(), false),
        payment_source: v.withDefault(v.str(), "bank-transfer"),
        payment_reference: v.optional(v.str()),
      },
    });
    const id = c.req.param("account_id");
    await staff(
      c,
      "staff:billing",
      "billing_account.invoice.mark_paid",
      ["billing_account", id],
      body,
    );
    await liveAccount(id);
    const details: Record<string, unknown> = { source: body.payment_source };
    if (body.payment_reference) details.sourceReference = body.payment_reference;
    const out = await billing
      .issueSalesInvoice(id, {
        seats: body.seats,
        amountEur: body.amount_eur,
        isEInvoice: body.is_einvoice,
        markPaid: true,
        paymentDetails: details,
      })
      .catch(billingBad);
    // The invoice's own status replaces "ok", as the old dict merge did.
    return c.json(Object.assign({ status: "ok" }, out));
  });

  return app;
}
