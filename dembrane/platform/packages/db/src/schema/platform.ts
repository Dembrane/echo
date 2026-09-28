import { index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/** One row per live worker process; a stale row marks a dead worker whose workflows get resumed. */
export const dbos_executor_heartbeat = pgTable("dbos_executor_heartbeat", {
  executor_id: text("executor_id").primaryKey(),
  last_seen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
});

// Fixed-window counters for rate limits (per user or per IP). Unlogged: a crash may
// forget recent counts, which only ever loosens a limit for one window.
export const platform_rate_limit = pgTable("platform_rate_limit", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
});

// Short-lived presence state the Python API kept in Redis: participant liveness pings,
// pre-conversation visitor sessions, the monitor's active-conversation index and the
// concurrent recording meter. One row per (kind, key); `scope` groups rows for reads
// (a project, a billing account). Rows past expires_at count as absent and are pruned
// on write. Unlogged: a crash forgets at most a few seconds of pings, which the next
// ping restores, and skipping the WAL keeps a ping every few seconds per device cheap.
export const platform_presence = pgTable(
  "platform_presence",
  {
    kind: text("kind").notNull(),
    key: text("key").notNull(),
    scope: text("scope").notNull().default(""),
    data: jsonb("data"),
    seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.kind, t.key] }),
    index("platform_presence_scope_idx").on(t.kind, t.scope, t.seenAt),
    index("platform_presence_expires_idx").on(t.expiresAt),
  ],
);
