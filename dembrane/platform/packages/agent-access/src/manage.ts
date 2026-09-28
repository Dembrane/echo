import type { Capture } from "@dembrane/analytics";
import { BadRequestError, ForbiddenError, NotFoundError } from "@dembrane/core";
import { type Ctx, type Env, requireUser, type Signed, v } from "@dembrane/http";
import { Hono } from "hono";
import {
  CONSENT_VERSION,
  FREE_TIER_MONTHLY_CALLS,
  GRANT_EXPIRY_CHOICES_DAYS,
  SCOPE_READ,
  SERVERS,
  VALID_SCOPES,
} from "./constants";
import { type AgentDeps, grantIsLive, monthKey, orgIsPaid } from "./context";
import {
  approveAuthorizeRequest,
  denyAuthorizeRequest,
  ExpiredRequest,
  issuerUrl,
  loadAuthorizeRequest,
} from "./oauth";
import { netloc } from "./oauthurl";
import type { Row } from "./storage";

/**
 * What the "Connect your agent" page, the consent screen and the org admin's MCP access
 * section call, mounted at /api/v2/agent-access with the normal signed-in session:
 * the server catalogue, the consent step of the OAuth flow, the person's own grants, the
 * org switch with usage and per-org grants, and the audit trail.
 */

const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** The signed-in person's app user id; 403 before onboarding, as get_app_user_or_raise. */
function appUserOf(who: Signed): string {
  if (!who.appUserId) throw new ForbiddenError("User not onboarded");
  return who.appUserId;
}

async function requireOrgRole(d: AgentDeps, orgId: string, appUserId: string): Promise<string> {
  const role = await d.store.orgRole(orgId, appUserId);
  if (role === null) throw new ForbiddenError("No access to this organisation");
  if (role !== "admin" && role !== "owner")
    throw new ForbiddenError("Organisation admins or owners only");
  return role;
}

/**
 * Org memberships plus, for guests, the orgs of workspaces they were added to directly: a
 * guest has data in that org and grants are org-scoped, so it must be selectable. The
 * role "guest" never manages anything.
 */
async function myMemberships(d: AgentDeps, appUserId: string) {
  const memberships: { org_id: string; role: string | null }[] =
    await d.store.orgMemberships(appUserId);
  const seen = new Set(memberships.map((m) => m.org_id));
  for (const orgId of await d.store.guestOrgIds(appUserId, d.now()))
    if (!seen.has(orgId)) {
      memberships.push({ org_id: orgId, role: "guest" });
      seen.add(orgId);
    }
  return memberships;
}

async function orgAccessOut(d: AgentDeps, org: Row, role: string) {
  const orgId = String(org.id);
  const paid = await orgIsPaid(d, orgId);
  const now = d.now();
  return {
    id: orgId,
    name: String(org.name ?? ""),
    role,
    can_manage: role === "admin" || role === "owner",
    agent_access_enabled: Boolean(org.agent_access_enabled),
    is_paid: paid,
    calls_this_month: await d.store.usageGet(orgId, monthKey(now), now),
    monthly_limit: paid ? null : FREE_TIER_MONTHLY_CALLS,
    updated_at: s(org.agent_access_updated_at),
  };
}

async function myOrgs(d: AgentDeps, appUserId: string) {
  const memberships = await myMemberships(d, appUserId);
  const orgs = new Map(
    (await d.store.orgs(memberships.map((m) => m.org_id))).map((o) => [String(o.id), o]),
  );
  const out = [];
  for (const m of memberships) {
    const org = orgs.get(m.org_id);
    if (org) out.push(await orgAccessOut(d, org, m.role || "member"));
  }
  return out;
}

function grantStatus(grant: Row, now: Date): "active" | "expired" | "revoked" {
  if (grant.revoked_at) return "revoked";
  return grantIsLive(grant, now) ? "active" : "expired";
}

function grantOut(grant: Row, names: Map<string, string>, now: Date, user?: Row) {
  const orgIds = Array.isArray(grant.org_ids) ? grant.org_ids.map(String) : [];
  return {
    id: String(grant.id),
    client_id: String(grant.client_id),
    client_name: s(grant.client_name),
    org_ids: orgIds,
    org_names: orgIds.map((o) => names.get(o) ?? ""),
    scopes: Array.isArray(grant.scopes) ? grant.scopes.map(String) : [],
    created_at: s(grant.created_at),
    expires_at: s(grant.expires_at),
    last_used_at: s(grant.last_used_at),
    revoked_at: s(grant.revoked_at),
    status: grantStatus(grant, now),
    user_email: user ? s(user.email) : null,
    user_display_name: user ? s(user.display_name) : null,
  };
}

async function orgNamesOf(d: AgentDeps, grants: readonly Row[]): Promise<Map<string, string>> {
  const ids = [
    ...new Set(grants.flatMap((g) => (Array.isArray(g.org_ids) ? g.org_ids.map(String) : []))),
  ].sort();
  return new Map((await d.store.orgs(ids)).map((o) => [String(o.id), String(o.name ?? "")]));
}

export function manageRoutes(d: AgentDeps, capture: Capture) {
  const P = "/api/v2/agent-access";
  const app = new Hono<Env>();
  const who = (c: Ctx) => requireUser(c);

  app.get(`${P}/servers`, async (c) => {
    appUserOf(who(c));
    return c.json({
      servers: SERVERS.map((srv) => ({
        id: srv.id,
        name: srv.name,
        summary: srv.summary,
        data_reach: srv.data_reach,
        can_change: srv.can_change,
        tools: srv.tools,
        mcp_url: issuerUrl(d),
        scopes: [...VALID_SCOPES],
      })),
      consent_version: CONSENT_VERSION,
      expiry_choices_days: [...GRANT_EXPIRY_CHOICES_DAYS],
      free_tier_monthly_calls: FREE_TIER_MONTHLY_CALLS,
    });
  });

  app.get(`${P}/authorize-requests/:id`, async (c) => {
    const appUserId = appUserOf(who(c));
    const requestId = c.req.param("id");
    const pending = await loadAuthorizeRequest(d, requestId);
    if (!pending)
      throw new NotFoundError(
        "This authorisation request has expired. Start again from your agent.",
      );
    const scopes =
      Array.isArray(pending.scopes) && pending.scopes.length ? pending.scopes : [SCOPE_READ];
    return c.json({
      request_id: requestId,
      client_name: s(pending.client_name),
      client_id: String(pending.client_id),
      redirect_host: netloc(String(pending.redirect_uri ?? "")),
      requested_scopes: scopes.map(String),
      organisations: await myOrgs(d, appUserId),
      consent_version: CONSENT_VERSION,
      expiry_choices_days: [...GRANT_EXPIRY_CHOICES_DAYS],
    });
  });

  app.post(`${P}/authorize-requests/:id/approve`, async (c) => {
    const signed = who(c);
    const { body } = await v.validate(c, {
      body: {
        org_ids: v.list(v.str(), { min: 1 }),
        scopes: v.withDefault(v.list(v.str()), [SCOPE_READ]),
        expires_in_days: v.withDefault(v.int(), 90),
        consent_accepted: v.bool(),
      },
    });
    const appUserId = appUserOf(signed);
    if (!body.consent_accepted) throw new BadRequestError("The data risk notice must be accepted");
    if (!(GRANT_EXPIRY_CHOICES_DAYS as readonly number[]).includes(body.expires_in_days))
      throw new BadRequestError("Unsupported expiry");
    const scopes = body.scopes.filter((x) => (VALID_SCOPES as readonly string[]).includes(x));
    if (!scopes.includes(SCOPE_READ)) scopes.unshift(SCOPE_READ);
    // Only orgs the person belongs to and that an admin has switched on.
    const allowed = new Set(
      (await myOrgs(d, appUserId)).filter((o) => o.agent_access_enabled).map((o) => o.id),
    );
    const orgIds = body.org_ids.filter((o) => allowed.has(o));
    if (!orgIds.length)
      throw new BadRequestError("Pick at least one organisation where agent access is switched on");
    let redirectUrl: string;
    try {
      redirectUrl = await approveAuthorizeRequest(d, {
        requestId: c.req.param("id"),
        appUserId,
        directusUserId: signed.directusUserId,
        orgIds,
        scopes,
        expiresInDays: body.expires_in_days,
        consentVersion: CONSENT_VERSION,
      });
    } catch (err) {
      if (err instanceof ExpiredRequest) throw new NotFoundError(err.message);
      throw err;
    }
    await capture(signed.directusUserId, "agent_grant_created", {
      org_count: orgIds.length,
      scopes,
      expires_in_days: body.expires_in_days,
    });
    return c.json({ redirect_url: redirectUrl });
  });

  app.post(`${P}/authorize-requests/:id/deny`, async (c) => {
    appUserOf(who(c));
    try {
      return c.json({ redirect_url: await denyAuthorizeRequest(d, c.req.param("id")) });
    } catch (err) {
      if (err instanceof ExpiredRequest) throw new NotFoundError(err.message);
      throw err;
    }
  });

  app.get(`${P}/grants`, async (c) => {
    const appUserId = appUserOf(who(c));
    const grants = await d.store.grantsOfUser(appUserId);
    const names = await orgNamesOf(d, grants);
    const now = d.now();
    return c.json(grants.map((g) => grantOut(g, names, now)));
  });

  app.delete(`${P}/grants/:id`, async (c) => {
    const signed = who(c);
    const appUserId = appUserOf(signed);
    const grant = await d.store.grant(c.req.param("id"));
    if (!grant || String(grant.app_user_id) !== appUserId)
      throw new NotFoundError("Grant not found");
    await d.store.revokeGrant(String(grant.id), d.now());
    await capture(signed.directusUserId, "agent_grant_revoked", { by: "owner" });
    return c.json({ status: "revoked" });
  });

  app.get(`${P}/organisations`, async (c) => c.json(await myOrgs(d, appUserOf(who(c)))));

  app.patch(`${P}/organisations/:org`, async (c) => {
    const signed = who(c);
    const { body } = await v.validate(c, { body: { enabled: v.bool() } });
    const appUserId = appUserOf(signed);
    const orgId = c.req.param("org");
    const role = await requireOrgRole(d, orgId, appUserId);
    // Switching off is immediate: every grant naming this org fails its next call at the
    // org check, which reads the switch fresh. Nothing else to revoke.
    await d.store.setOrgAccess(orgId, body.enabled, appUserId, d.now());
    await capture(signed.directusUserId, "agent_access_org_toggled", {
      org_id: orgId,
      enabled: body.enabled,
    });
    const org = (await d.store.orgs([orgId]))[0] ?? {
      id: orgId,
      name: "",
      agent_access_enabled: body.enabled,
    };
    return c.json(await orgAccessOut(d, org, role));
  });

  app.get(`${P}/organisations/:org/grants`, async (c) => {
    const appUserId = appUserOf(who(c));
    const orgId = c.req.param("org");
    await requireOrgRole(d, orgId, appUserId);
    const grants = await d.store.grantsOfOrg(orgId);
    const users = await d.store.appUsers(
      [...new Set(grants.map((g) => s(g.app_user_id)).filter((x): x is string => !!x))].sort(),
    );
    const names = await orgNamesOf(d, grants);
    const now = d.now();
    return c.json(grants.map((g) => grantOut(g, names, now, users.get(String(g.app_user_id)))));
  });

  app.delete(`${P}/organisations/:org/grants/:grant`, async (c) => {
    const signed = who(c);
    const appUserId = appUserOf(signed);
    const orgId = c.req.param("org");
    await requireOrgRole(d, orgId, appUserId);
    const grant = await d.store.grant(c.req.param("grant"));
    if (!grant || !(Array.isArray(grant.org_ids) && grant.org_ids.map(String).includes(orgId)))
      throw new NotFoundError("Grant not found");
    await d.store.revokeGrant(String(grant.id), d.now());
    await capture(signed.directusUserId, "agent_grant_revoked", { by: "org_admin", org_id: orgId });
    return c.json({ status: "revoked" });
  });

  app.get(`${P}/audit`, async (c) => {
    const signed = who(c);
    const { query } = await v.validate(c, {
      query: {
        org_id: v.optional(v.str()),
        limit: v.withDefault(v.int({ ge: 1, le: 500 }), 100),
        offset: v.withDefault(v.int({ ge: 0 }), 0),
      },
    });
    const appUserId = appUserOf(signed);
    let rows: Row[];
    if (query.org_id) {
      await requireOrgRole(d, query.org_id, appUserId);
      rows = await d.store.audit({ orgId: query.org_id }, query.limit, query.offset);
    } else rows = await d.store.audit({ appUserId }, query.limit, query.offset);
    // Names come from the grant (agent) and app_user (person), so an admin reads people and
    // tools, not ids. Revoked grants still resolve.
    const grantIds = [...new Set(rows.map((r) => s(r.grant_id)).filter((x): x is string => !!x))];
    const grantNames = new Map<string, string | null>();
    for (const id of grantIds) {
      const g = await d.store.grant(id);
      if (g) grantNames.set(id, s(g.client_name));
    }
    const users = await d.store.appUsers(
      [...new Set(rows.map((r) => s(r.app_user_id)).filter((x): x is string => !!x))].sort(),
    );
    return c.json(
      rows.map((r) => {
        const user = users.get(String(r.app_user_id));
        return {
          id: String(r.id),
          grant_id: String(r.grant_id),
          client_id: String(r.client_id),
          client_name: grantNames.get(String(r.grant_id)) ?? null,
          app_user_id: String(r.app_user_id),
          user_display_name: user ? s(user.display_name) : null,
          user_email: user ? s(user.email) : null,
          org_id: s(r.org_id),
          tool: String(r.tool ?? ""),
          params:
            r.params && typeof r.params === "object" && !Array.isArray(r.params) ? r.params : {},
          status: String(r.status ?? ""),
          duration_ms: r.duration_ms ?? null,
          created_at: s(r.created_at),
        };
      }),
    );
  });

  return app;
}
