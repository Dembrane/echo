import type { Access, AccessStore } from "@dembrane/access";
import {
  ForbiddenError,
  NotFoundError,
  PlatformError,
  RateLimitedError,
  UnauthenticatedError,
} from "@dembrane/core";
import type { Db } from "@dembrane/db";
import type { Signed } from "@dembrane/http";
import type { Logger } from "@dembrane/observability";
import type { SamQueue } from "@dembrane/webhooks";
import type postgres from "postgres";
import { FREE_TIER_MONTHLY_CALLS, SCOPE_WRITE } from "./constants";
import type { AgentStorage, Row } from "./storage";

/** Everything agent access needs from the API; built once in app.ts. */
export interface AgentDeps {
  readonly db: Db;
  readonly access: Access;
  readonly accessStore: AccessStore;
  readonly store: AgentStorage;
  readonly logger: Logger;
  readonly now: () => Date;
  /** Base URL of the API as clients reach it; the issuer is this plus /api/mcp. */
  readonly publicUrl: string;
  readonly dashboardUrl: string;
  /** Build stamp reported by whoami and the tool catalogue (the Python BUILD_VERSION). */
  readonly buildVersion: string;
  /**
   * sam's inbox, when SAM_INBOX_* is set: tool requests are queued for it in the same
   * transaction as their insight row. Absent, they stay in the insights table only.
   */
  readonly samInbox?: SamInboxDeps | null;
}

/** Queues inbox messages in a postgres.js transaction; `environment` labels them for sam. */
export interface SamInboxDeps {
  readonly sink: SamQueue<postgres.TransactionSql>;
  readonly environment: string;
}

/** Month key of the free-tier counter, in UTC like the Python strftime("%Y%m"). */
export const monthKey = (d: Date) =>
  `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

export function grantIsLive(grant: Row, at: Date): boolean {
  if (grant.revoked_at) return false;
  const expires = Date.parse(String(grant.expires_at ?? ""));
  return Number.isFinite(expires) && expires > at.getTime();
}

export async function orgAgentAccessEnabled(d: AgentDeps, orgId: string): Promise<boolean> {
  const org = await d.store.org(orgId);
  return Boolean(org?.agent_access_enabled && !org.deleted_at);
}

/** Any workspace in the org above the free tier makes the org paid. */
export async function orgIsPaid(d: AgentDeps, orgId: string): Promise<boolean> {
  return (await d.store.orgTiers(orgId)).some((t) => t !== null && t !== "free");
}

/**
 * Who an agent acts as and where it may look, shared by REST and MCP so both enforce the
 * same rules: the grant is live, the org is in the grant and switched on, the scope covers
 * the call, a free org is under its monthly budget. Every call ends in `record`.
 *
 * The Python API cached the org switch and the paid flag in Redis for a minute and five
 * minutes; they are read fresh here, so an admin switching access off takes effect on the
 * very next call.
 */
export class AgentContext {
  /** Set by requireOrg so the audit row names the org a call touched. */
  touchedOrgId: string | null = null;
  private readonly startedAt = performance.now();

  constructor(
    private readonly d: AgentDeps,
    readonly grantId: string,
    readonly clientId: string,
    readonly clientName: string,
    readonly appUserId: string,
    readonly directusUserId: string,
    readonly orgIds: readonly string[],
    readonly scopes: readonly string[],
    /** The person as the access rules see them; never staff, whatever their Directus role. */
    readonly who: Signed,
  ) {}

  hasScope(scope: string): boolean {
    return this.scopes.includes(scope);
  }

  requireWrite(): void {
    if (!this.hasScope(SCOPE_WRITE))
      throw new ForbiddenError("agent_access.scope_missing", { params: { scope: SCOPE_WRITE } });
  }

  /** The org must be in the grant and switched on. */
  async requireOrg(orgId: string | null): Promise<string> {
    if (!orgId || !this.orgIds.includes(orgId))
      throw new NotFoundError("agent_access.organisation_not_granted");
    this.touchedOrgId = orgId;
    if (!(await orgAgentAccessEnabled(this.d, orgId)))
      throw new ForbiddenError("agent_access.disabled_by_admin");
    return orgId;
  }

  /** Counts one call against a free org's monthly budget. */
  async charge(orgId: string): Promise<void> {
    if (await orgIsPaid(this.d, orgId)) return;
    const now = this.d.now();
    const count = await this.d.store.usageIncrement(orgId, monthKey(now), now);
    if (count > FREE_TIER_MONTHLY_CALLS)
      throw new RateLimitedError("agent_access.free_tier_calls_used", {
        params: { limit: FREE_TIER_MONTHLY_CALLS },
      });
  }

  /** The audit row. Best effort: a failed write never changes the answer it records. */
  async record(tool: string, params: Row, orgId: string | null, status: string): Promise<void> {
    const now = this.d.now();
    try {
      await this.d.store.writeAudit({
        grantId: this.grantId,
        appUserId: this.appUserId,
        clientId: this.clientId,
        orgId: orgId ?? this.touchedOrgId,
        tool,
        params,
        status,
        durationMs: Math.trunc(performance.now() - this.startedAt),
        now,
      });
    } catch (err) {
      this.d.logger.warn({ err, tool, grant: this.grantId }, "agent audit write failed");
    }
    if (status === "ok") await this.d.store.touchGrant(this.grantId, now);
  }
}

/** Audit status of a refused call, as the Python _run classified HTTP errors. */
export function auditStatus(err: unknown): string {
  if (!(err instanceof PlatformError)) return "error";
  if (err.status === 429) return "limited";
  if (err.status === 401 || err.status === 403 || err.status === 404) return "denied";
  return "error";
}

/**
 * The context for a grant whose access token was already verified. A grant that was
 * revoked or expired meanwhile answers 401. So does one whose person is suspended or
 * archived (spec M-18: the Python API kept such grants working until they expired, up to
 * a year); their session sign-in is refused the same way.
 */
export async function contextForGrant(d: AgentDeps, grantId: string): Promise<AgentContext> {
  const now = d.now();
  const grant = await d.store.grant(grantId);
  if (!grant || !grantIsLive(grant, now))
    throw new UnauthenticatedError("agent_access.grant_inactive");
  const directusUserId = String(grant.directus_user_id);
  const status = await d.store.directusStatus(directusUserId);
  if (status === "suspended" || status === "archived")
    throw new UnauthenticatedError("agent_access.grant_inactive");
  // The Python session resolved the app user from the Directus id on every call; one whose
  // app_user row is gone reads as not onboarded (403), as there.
  const appUser = await d.store.appUserOfDirectus(directusUserId);
  return new AgentContext(
    d,
    String(grant.id),
    String(grant.client_id),
    String(grant.client_name || "agent"),
    String(grant.app_user_id),
    directusUserId,
    Array.isArray(grant.org_ids) ? grant.org_ids.map(String) : [],
    Array.isArray(grant.scopes) ? grant.scopes.map(String) : [],
    { appUserId: appUser ? String(appUser.id) : null, directusUserId, isStaff: false },
  );
}
