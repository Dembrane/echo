import type { Db } from "@dembrane/db";
import { directusTime, type Env, requireUser, type Signed, v } from "@dembrane/http";
import { Hono } from "hono";
import {
  type AuditFilter,
  type AuditScope,
  type AuditStorage,
  auditStorage,
} from "./audit-storage";

/**
 * Everyone reads the rows by or about themselves. Directus let staff read every tenant's
 * activity here, unaudited (spec H-14); this is a settings card, not a staff tool.
 * Revisions were withdrawn from Basic Users on 2026-09-14, so only staff get the field deltas.
 */
export function auditScope(who: Signed): AuditScope {
  return { all: false, userId: who.directusUserId };
}

/** "a,b" or repeated values; blanks dropped. */
export function csv(value: string | null): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function auditPage(
  store: AuditStorage,
  who: Signed,
  f: AuditFilter,
  q: { cursor?: number | null; page_size: number; sort: "asc" | "desc" },
) {
  const scope = auditScope(who);
  // One extra row tells whether another page exists, so no count over the table is needed.
  const fetched = await store.page(scope, f, {
    limit: q.page_size + 1,
    after: q.cursor ?? undefined,
    ascending: q.sort === "asc",
  });
  const rows = fetched.slice(0, q.page_size);
  const hasMore = fetched.length > rows.length;
  const deltas = who.isStaff ? await store.deltas(rows.map((r) => r.id)) : [];
  return {
    items: rows.map((r) => ({
      id: r.id,
      action: r.action,
      collection: r.collection,
      item: r.item,
      timestamp: directusTime(r.timestamp),
      ip: r.ip,
      user_agent: r.user_agent,
      user: r.userId
        ? { id: r.userId, email: r.email, first_name: r.first_name, last_name: r.last_name }
        : null,
      revisions: deltas.filter((d) => d.activity === r.id).map((d) => ({ delta: d.delta })),
    })),
    has_more: hasMore,
    /** Pass as `cursor` to get the page after this one. */
    next_cursor: hasMore ? (rows[rows.length - 1]?.id ?? null) : null,
  };
}

export async function auditOptions(store: AuditStorage, who: Signed) {
  const rows = await store.counts(auditScope(who));
  const tally = (key: "action" | "collection") => {
    const byValue = new Map<string, number>();
    for (const r of rows) {
      const value = r[key];
      if (value?.trim()) byValue.set(value, (byValue.get(value) ?? 0) + r.count);
    }
    return [...byValue]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([value, count]) => ({ value, label: value, count }));
  };
  return { actions: tally("action"), collections: tally("collection") };
}

/** /api/user-settings/audit-logs: the caller's activity log on the settings page. */
export function auditRoutes(deps: { db: Db }) {
  const store = auditStorage(deps.db);
  const base = "/api/user-settings/audit-logs";
  return new Hono<Env>()
    .get(base, async (c) => {
      const who = requireUser(c);
      const { query } = await v.validate(c, {
        query: {
          cursor: v.optional(v.int({ ge: 0 })),
          page_size: v.withDefault(v.int({ ge: 1, le: 500 }), 25),
          sort: v.withDefault(v.literal(["asc", "desc"]), "desc"),
          actions: v.optional(v.str()),
          collections: v.optional(v.str()),
        },
      });
      const filter = { actions: csv(query.actions), collections: csv(query.collections) };
      return c.json(await auditPage(store, who, filter, query));
    })
    .get(`${base}/options`, async (c) => c.json(await auditOptions(store, requireUser(c))));
}
