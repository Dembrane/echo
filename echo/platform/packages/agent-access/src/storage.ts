import { newId } from "@echo/core";
import type { Db } from "@echo/db";
import { directusRow } from "@echo/legacy-shape";
import { PostgresRateCounter } from "@echo/ratelimit";
import type postgres from "postgres";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  TOKEN_PREFIX_ACCESS,
  TOKEN_PREFIX_REFRESH,
} from "./constants";
import { hashToken, mintToken } from "./secrets";

export type Row = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A malformed id names nothing; Directus answered such lookups as not found. */
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

const sqlOf = (db: Db): postgres.Sql => (db as unknown as { $client: postgres.Sql }).$client;

/** Rows as Directus served them: ISO timestamps, parsed JSON. */
const shape = (r: Row): Row => directusRow(r);
const shapeAll = (rows: readonly Row[]): Row[] => rows.map(shape);

// Presence kinds for what the Python API parked in Redis. The table is unlogged: a crash
// loses at most in-flight consent screens and codes (minutes long), which the agent
// restarts, exactly as a Redis restart did.
const AUTHZ = "agent_authz";
const CODE = "agent_code";

// Monthly usage counts live in the rate-limit table under this prefix, one row per org and
// month, kept 40 days like the Redis key. Unlogged too: a crash can only forget calls,
// which loosens the free budget for the rest of that month and never blocks anyone.
const USAGE_WINDOW_SECONDS = 40 * 24 * 60 * 60;
const usageKey = (orgId: string, month: string) => `agent_usage:${orgId}:${month}`;

/**
 * Every query agent access makes. Agent rows (clients, grants, tokens, audit) are this
 * package's own; org, membership and project reads are the few the shared packages do
 * not export in the shape the tools need.
 */
export function agentStorage(db: Db) {
  const sql = sqlOf(db);
  const usage = new PostgresRateCounter(db);

  return {
    sql,

    // ── clients ────────────────────────────────────────────────────────

    async client(id: string): Promise<Row | null> {
      if (!isUuid(id)) return null;
      const [r] = await sql`select * from agent_client where id = ${id}`;
      return r ? shape(r) : null;
    },

    async createClient(c: {
      id: string;
      clientName: string | null;
      authMethod: string;
      secretEncrypted: string | null;
      redirectUris: string[];
      metadata: Row;
      now: Date;
    }): Promise<void> {
      await sql`insert into agent_client
        (id, client_name, token_endpoint_auth_method, client_secret_encrypted, redirect_uris, metadata, created_at)
        values (${c.id}, ${c.clientName}, ${c.authMethod}, ${c.secretEncrypted},
          ${sql.json(c.redirectUris)}, ${sql.json(c.metadata as postgres.JSONValue)}, ${c.now.toISOString()})`;
    },

    /** Bookkeeping only: never fails the token exchange that triggers it. */
    async touchClient(id: string, now: Date): Promise<void> {
      await sql`update agent_client set last_seen_at = ${now.toISOString()} where id = ${id}`.catch(
        () => {},
      );
    },

    // ── grants ─────────────────────────────────────────────────────────

    async createGrant(g: {
      appUserId: string;
      directusUserId: string;
      clientId: string;
      clientName: string | null;
      orgIds: string[];
      scopes: string[];
      expiresAt: Date;
      consentVersion: string;
      now: Date;
    }): Promise<string> {
      const id = newId();
      const now = g.now.toISOString();
      await sql`insert into agent_grant
        (id, app_user_id, directus_user_id, client_id, client_name, org_ids, scopes,
         consent_accepted_at, consent_version, expires_at, revoked_at, last_used_at, created_at)
        values (${id}, ${g.appUserId}, ${g.directusUserId}, ${g.clientId}, ${g.clientName},
          ${sql.json(g.orgIds)}, ${sql.json(g.scopes)}, ${now}, ${g.consentVersion},
          ${g.expiresAt.toISOString()}, null, null, ${now})`;
      return id;
    },

    async grant(id: string): Promise<Row | null> {
      if (!isUuid(id)) return null;
      const [r] = await sql`select * from agent_grant where id = ${id}`;
      return r ? shape(r) : null;
    },

    async grantsOfUser(appUserId: string): Promise<Row[]> {
      return shapeAll(
        await sql`select * from agent_grant where app_user_id = ${appUserId}
          order by created_at desc, id desc`,
      );
    },

    /** Live-or-expired, unrevoked grants naming this org; org_ids is JSON, filtered here. */
    async grantsOfOrg(orgId: string): Promise<Row[]> {
      const rows = shapeAll(
        await sql`select * from agent_grant where revoked_at is null order by created_at desc, id desc`,
      );
      return rows.filter((g) => Array.isArray(g.org_ids) && g.org_ids.map(String).includes(orgId));
    },

    /** Revokes the grant and every token still live under it, in one transaction. */
    async revokeGrant(id: string, now: Date): Promise<void> {
      const at = now.toISOString();
      await sql.begin(async (tx) => {
        await tx`update agent_grant set revoked_at = ${at} where id = ${id}`;
        await tx`update agent_token set revoked_at = ${at} where grant_id = ${id} and revoked_at is null`;
      });
    },

    async touchGrant(id: string, now: Date): Promise<void> {
      await sql`update agent_grant set last_used_at = ${now.toISOString()} where id = ${id}`.catch(
        () => {},
      );
    },

    // ── tokens ─────────────────────────────────────────────────────────

    /** One access and one refresh token for a grant; the raw strings are shown to the client once. */
    async mintTokenPair(grantId: string, now: Date): Promise<{ access: string; refresh: string }> {
      const pair = newId();
      const access = mintToken(TOKEN_PREFIX_ACCESS);
      const refresh = mintToken(TOKEN_PREFIX_REFRESH);
      const at = now.toISOString();
      const accessExpires = new Date(now.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString();
      const refreshExpires = new Date(
        now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000,
      ).toISOString();
      await sql`insert into agent_token
        (id, grant_id, kind, token_hash, pair_id, expires_at, revoked_at, created_at) values
        (${newId()}, ${grantId}, 'access', ${hashToken(access)}, ${pair}, ${accessExpires}, null, ${at}),
        (${newId()}, ${grantId}, 'refresh', ${hashToken(refresh)}, ${pair}, ${refreshExpires}, null, ${at})`;
      return { access, refresh };
    },

    /** The live token row for a raw token: right kind, not revoked, not expired. */
    async liveToken(raw: string, kind: "access" | "refresh", now: Date): Promise<Row | null> {
      const [r] = await sql`select * from agent_token
        where token_hash = ${hashToken(raw)} and kind = ${kind} and revoked_at is null limit 1`;
      if (!r) return null;
      const row = shape(r);
      const expires = Date.parse(String(row.expires_at ?? ""));
      return Number.isFinite(expires) && expires > now.getTime() ? row : null;
    },

    /** A token row in any state, for spotting a rotated refresh token being replayed. */
    async anyToken(raw: string, kind: "access" | "refresh"): Promise<Row | null> {
      const [r] = await sql`select * from agent_token
        where token_hash = ${hashToken(raw)} and kind = ${kind} limit 1`;
      return r ? shape(r) : null;
    },

    async revokePair(pairId: string, now: Date): Promise<void> {
      await sql`update agent_token set revoked_at = ${now.toISOString()}
        where pair_id = ${pairId} and revoked_at is null`;
    },

    // ── parked authorisation requests and codes ────────────────────────

    async park(kind: "authz" | "code", key: string, data: Row, ttlSeconds: number, now: Date) {
      const k = kind === "authz" ? AUTHZ : CODE;
      const expires = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
      await sql`insert into platform_presence (kind, key, scope, data, seen_at, expires_at)
        values (${k}, ${key}, '', ${sql.json(data as postgres.JSONValue)}, ${now.toISOString()}, ${expires})
        on conflict (kind, key) do update set data = excluded.data, seen_at = excluded.seen_at,
          expires_at = excluded.expires_at`;
    },

    async parked(kind: "authz" | "code", key: string, now: Date): Promise<Row | null> {
      const k = kind === "authz" ? AUTHZ : CODE;
      const [r] = await sql`select data from platform_presence
        where kind = ${k} and key = ${key} and expires_at > ${now.toISOString()}`;
      return r ? ((r.data as Row) ?? null) : null;
    },

    /** Read and delete in one statement, so a code or a consent request is used once. */
    async take(kind: "authz" | "code", key: string, now: Date): Promise<Row | null> {
      const k = kind === "authz" ? AUTHZ : CODE;
      const [r] = await sql`delete from platform_presence where kind = ${k} and key = ${key}
        returning data, expires_at`;
      if (!r || Date.parse(String(r.expires_at)) <= now.getTime()) return null;
      return (r.data as Row) ?? null;
    },

    // ── usage ──────────────────────────────────────────────────────────

    usageIncrement(orgId: string, month: string, now: Date): Promise<number> {
      return usage.hit(usageKey(orgId, month), USAGE_WINDOW_SECONDS, now);
    },

    async usageGet(orgId: string, month: string, now: Date): Promise<number> {
      const [r] = await sql`select count from platform_rate_limit
        where key = ${usageKey(orgId, month)} and reset_at > ${now.toISOString()}`;
      return r ? Number(r.count) : 0;
    },

    // ── audit ──────────────────────────────────────────────────────────

    async writeAudit(e: {
      grantId: string;
      appUserId: string;
      clientId: string;
      orgId: string | null;
      tool: string;
      params: Row;
      status: string;
      durationMs: number;
      now: Date;
    }): Promise<void> {
      await sql`insert into agent_audit_event
        (id, grant_id, app_user_id, client_id, org_id, tool, params, status, duration_ms, created_at)
        values (${newId()}, ${e.grantId}, ${e.appUserId}, ${e.clientId}, ${e.orgId}, ${e.tool},
          ${sql.json(e.params as postgres.JSONValue)}, ${e.status}, ${e.durationMs}, ${e.now.toISOString()})`;
    },

    async audit(
      by: { appUserId: string } | { orgId: string },
      limit: number,
      offset: number,
    ): Promise<Row[]> {
      const rows =
        "orgId" in by
          ? await sql`select * from agent_audit_event where org_id = ${by.orgId}
              order by created_at desc, id desc limit ${limit} offset ${offset}`
          : await sql`select * from agent_audit_event where app_user_id = ${by.appUserId}
              order by created_at desc, id desc limit ${limit} offset ${offset}`;
      return shapeAll(rows);
    },

    // ── people ─────────────────────────────────────────────────────────

    async appUserOfDirectus(directusUserId: string): Promise<Row | null> {
      if (!isUuid(directusUserId)) return null;
      const [r] = await sql`select id, email, display_name from app_user
        where directus_user_id = ${directusUserId} limit 1`;
      return r ? shape(r) : null;
    },

    async appUser(id: string): Promise<Row | null> {
      if (!isUuid(id)) return null;
      const [r] = await sql`select id, email, display_name from app_user where id = ${id}`;
      return r ? shape(r) : null;
    },

    async appUsers(ids: readonly string[]): Promise<Map<string, Row>> {
      const valid = ids.filter(isUuid);
      if (!valid.length) return new Map();
      const rows =
        await sql`select id, email, display_name from app_user where id in ${sql(valid)}`;
      return new Map(rows.map((r) => [String(r.id), shape(r)]));
    },

    /** Directus status of the person behind a grant: suspended and archived users sign in nowhere. */
    async directusStatus(directusUserId: string): Promise<string | null> {
      if (!isUuid(directusUserId)) return null;
      const [r] = await sql`select status from directus_users where id = ${directusUserId}`;
      return r ? String(r.status ?? "") : null;
    },

    // ── organisations ──────────────────────────────────────────────────

    async org(id: string): Promise<Row | null> {
      if (!isUuid(id)) return null;
      const [r] = await sql`select * from org where id = ${id}`;
      return r ? shape(r) : null;
    },

    /** Live orgs by id, in id order as Directus returned an `_in` read. */
    async orgs(ids: readonly string[]): Promise<Row[]> {
      const valid = ids.filter(isUuid);
      if (!valid.length) return [];
      return shapeAll(
        await sql`select id, name, agent_access_enabled, agent_access_updated_at from org
          where id in ${sql(valid)} and deleted_at is null order by id`,
      );
    },

    /** Org names by id, including soft-deleted orgs, as find_projects read them. */
    async orgNames(ids: readonly string[]): Promise<Map<string, string>> {
      const valid = ids.filter(isUuid);
      if (!valid.length) return new Map();
      const rows = await sql`select id, name from org where id in ${sql(valid)}`;
      return new Map(rows.map((r) => [String(r.id), String(r.name ?? "")]));
    },

    async setOrgAccess(orgId: string, enabled: boolean, by: string, now: Date): Promise<void> {
      await sql`update org set agent_access_enabled = ${enabled},
        agent_access_updated_at = ${now.toISOString()}, agent_access_updated_by = ${by}
        where id = ${orgId}`;
    },

    async orgMemberships(appUserId: string): Promise<{ org_id: string; role: string | null }[]> {
      const rows = await sql`select org_id, role from org_membership
        where user_id = ${appUserId} and deleted_at is null and org_id is not null order by id`;
      return rows.map((r) => ({
        org_id: String(r.org_id),
        role: r.role === null ? null : String(r.role),
      }));
    },

    async orgRole(orgId: string, appUserId: string): Promise<string | null> {
      if (!isUuid(orgId)) return null;
      const [r] = await sql`select role from org_membership
        where org_id = ${orgId} and user_id = ${appUserId} and deleted_at is null limit 1`;
      return r ? String(r.role ?? "") : null;
    },

    /** Orgs of workspaces the user holds a live, direct membership in, first seen first. */
    async guestOrgIds(appUserId: string, now: Date): Promise<string[]> {
      const rows = await sql`select w.org_id, wm.expires_at from workspace_membership wm
        join workspace w on w.id = wm.workspace_id
        where wm.user_id = ${appUserId} and wm.deleted_at is null
          and w.deleted_at is null and w.org_id is not null
        order by wm.id`;
      const out: string[] = [];
      for (const r of rows) {
        const exp = r.expires_at ? Date.parse(String(shape(r).expires_at)) : null;
        if (exp !== null && exp <= now.getTime()) continue;
        const org = String(r.org_id);
        if (!out.includes(org)) out.push(org);
      }
      return out;
    },

    /** Tiers of the org's live workspaces: any tier above free makes the org paid. */
    async orgTiers(orgId: string): Promise<(string | null)[]> {
      if (!isUuid(orgId)) return [];
      const rows = await sql`select b.tier from workspace w
        left join billing_account b on b.id = w.billing_account_id
        where w.org_id = ${orgId} and w.deleted_at is null order by w.id`;
      return rows.map((r) => (r.tier === null ? null : String(r.tier)));
    },

    /** Live workspaces of an org with their tier, in id order. */
    async orgWorkspaces(orgId: string): Promise<Row[]> {
      return shapeAll(
        await sql`select w.id, w.name, b.tier from workspace w
          left join billing_account b on b.id = w.billing_account_id
          where w.org_id = ${orgId} and w.deleted_at is null order by w.id`,
      );
    },

    async workspaceOrg(workspaceId: string): Promise<string | null> {
      if (!isUuid(workspaceId)) return null;
      const [r] = await sql`select org_id from workspace where id = ${workspaceId}`;
      return r?.org_id ? String(r.org_id) : null;
    },

    /** (workspace name, organisation name) for one workspace. */
    async placeNames(workspaceId: string): Promise<[string | null, string | null]> {
      if (!isUuid(workspaceId)) return [null, null];
      const [r] = await sql`select w.name as ws, o.name as org from workspace w
        left join org o on o.id = w.org_id where w.id = ${workspaceId}`;
      if (!r) return [null, null];
      return [r.ws === null ? null : String(r.ws), r.org === null ? null : String(r.org)];
    },

    // ── projects ───────────────────────────────────────────────────────

    async project(id: string): Promise<Row | null> {
      if (!isUuid(id)) return null;
      const [r] = await sql`select * from project where id = ${id}`;
      return r ? shape(r) : null;
    },

    async updateProject(id: string, fields: Row, now: Date): Promise<Row | null> {
      const set = { ...fields, updated_at: now.toISOString() };
      const [r] =
        await sql`update project set ${sql(set as Record<string, postgres.ParameterOrJSON<never>>)}
        where id = ${id} returning *`;
      return r ? shape(r) : null;
    },

    /** Workspaces reachable through a live membership, then every workspace of an org the user admins or owns. */
    async reachableWorkspaceIds(appUserId: string): Promise<string[]> {
      const direct = await sql`select workspace_id from workspace_membership
        where user_id = ${appUserId} and deleted_at is null order by id`;
      const out: string[] = [];
      for (const r of direct) {
        const id = r.workspace_id ? String(r.workspace_id) : null;
        if (id && !out.includes(id)) out.push(id);
      }
      const derived = await sql`select w.id from workspace w
        where w.deleted_at is null and w.org_id in (
          select org_id from org_membership where user_id = ${appUserId}
            and deleted_at is null and role in ('admin', 'owner'))
        order by w.id`;
      for (const r of derived) {
        const id = String(r.id);
        if (!out.includes(id)) out.push(id);
      }
      return out;
    },

    /**
     * Projects in these workspaces whose name holds every word of `query`, most recently
     * updated first. Words match case-insensitively anywhere in the name, in any order.
     */
    async projectsIn(workspaceIds: readonly string[], query: string | null, limit: number) {
      const ids = workspaceIds.filter(isUuid);
      if (!ids.length) return [];
      const words = (query ?? "").split(/\s+/).filter(Boolean);
      const nameMatch = words.length
        ? words.reduce(
            (acc, w, i) =>
              i === 0
                ? sql`lower(p.name) like ${`%${w.toLowerCase()}%`}`
                : sql`${acc} and lower(p.name) like ${`%${w.toLowerCase()}%`}`,
            sql``,
          )
        : sql`true`;
      return shapeAll(
        await sql`select p.id, p.name, p.workspace_id, p.updated_at, w.name as workspace_name, w.org_id
          from project p left join workspace w on w.id = p.workspace_id
          where p.workspace_id in ${sql(ids)} and p.deleted_at is null and (${nameMatch})
          order by p.updated_at desc limit ${limit}`,
      );
    },

    async projectWebhooks(projectId: string): Promise<Row[]> {
      return shapeAll(
        await sql`select id, name, url, events, status from project_webhook
          where project_id = ${projectId} and deleted_at is null
          order by date_created desc`,
      );
    },

    // ── tickets ────────────────────────────────────────────────────────

    async fileSupportRequest(r: {
      source: string;
      directusUserId: string;
      appUserId: string;
      workspaceId: string | null;
      projectId: string | null;
      message: string;
      pageContext: string;
      now: Date;
    }): Promise<string> {
      const id = newId();
      await sql`insert into support_request (id, source, directus_user_id, app_user_id, workspace_id,
          project_id, chat_id, message_id, message, page_context, status, created_at)
        values (${id}, ${r.source}, ${r.directusUserId}, ${r.appUserId}, ${r.workspaceId},
          ${r.projectId}, null, null, ${r.message}, ${r.pageContext}, 'new', ${r.now.toISOString()})`;
      return id;
    },

    async fileInsight(r: {
      source: string;
      kind: string;
      content: string;
      suggestedCapability: string | null;
      workspaceId: string | null;
      projectId: string | null;
      now: Date;
    }): Promise<string> {
      const id = newId();
      await sql`insert into agent_insight (id, source, workspace_id, project_id, chat_id, message_id,
          kind, content, suggested_capability, status, created_at)
        values (${id}, ${r.source}, ${r.workspaceId}, ${r.projectId}, null, null, ${r.kind},
          ${r.content}, ${r.suggestedCapability}, 'new', ${r.now.toISOString()})`;
      return id;
    },
  };
}

export type AgentStorage = ReturnType<typeof agentStorage>;
