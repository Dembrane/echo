import type { Db } from "@echo/db";
import { directusTime, type Env, requireUser, type Signed, v } from "@echo/http";
import { Hono } from "hono";
import {
  type AuditFilter,
  type AuditScope,
  type AuditStorage,
  auditStorage,
} from "./audit-storage";

/**
 * Directus let staff read all activity and everyone else the rows by or about themselves.
 * Revisions were withdrawn from Basic Users on 2026-09-14, so only staff get the field deltas.
 */
export function auditScope(who: Signed): AuditScope {
  return who.isStaff ? { all: true } : { all: false, userId: who.directusUserId };
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
  q: { page: number; page_size: number; sort: "asc" | "desc" },
) {
  const scope = auditScope(who);
  const [rows, total] = await Promise.all([
    store.page(scope, f, {
      limit: q.page_size,
      offset: q.page * q.page_size,
      ascending: q.sort === "asc",
    }),
    store.total(scope, f),
  ]);
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
    total,
  };
}

export async function auditOptions(store: AuditStorage, who: Signed) {
  const scope = auditScope(who);
  const [actions, collections] = await Promise.all([
    store.counts(scope, "action"),
    store.counts(scope, "collection"),
  ]);
  const options = (rows: { value: string | null; count: number }[]) =>
    rows
      .filter((r): r is { value: string; count: number } => !!r.value?.trim())
      .map((r) => ({ value: r.value, label: r.value, count: r.count }));
  return { actions: options(actions), collections: options(collections) };
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
          page: v.withDefault(v.int({ ge: 0 }), 0),
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
