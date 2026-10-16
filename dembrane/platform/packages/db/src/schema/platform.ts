import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/** One row per live worker process; a stale row marks a dead worker whose workflows get resumed. */
export const dbos_executor_heartbeat = pgTable("dbos_executor_heartbeat", {
  executor_id: text("executor_id").primaryKey(),
  last_seen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per unfinished workflow that was running on a worker that stopped: how often, and
 * when recovery set it aside instead of resuming it. The recovery sweep deletes the row once
 * the workflow finishes or a person resumes it.
 */
export const dbos_workflow_lost_worker = pgTable("dbos_workflow_lost_worker", {
  workflow_id: text("workflow_id").primaryKey(),
  /** The queue it ran on. DBOS clears its own copy on a cancelled workflow; a resume reads this one. */
  queue_name: text("queue_name"),
  lost: integer("lost").notNull(),
  set_aside_at: timestamp("set_aside_at", { withTimezone: true }),
});

/**
 * What a large popcorn session's tensions keep between reads (popcorn tick/scale.ts): positions
 * per conversation, the pairs found and their verdicts. Kept apart from agent_loop so the
 * deck's frequent reads and writes never carry it. Written only by the popcorn tick.
 */
export const popcorn_tensions_cache = pgTable("popcorn_tensions_cache", {
  loop_id: uuid("loop_id").primaryKey(),
  cache: jsonb("cache").notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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

// One row per attempt at a model deployment, written by metering from the llm observer:
// names and numbers only, never a prompt or an answer. The obs views aggregate it per day
// and per operation; Grafana reads those views, never this table.
export const model_call = pgTable(
  "model_call",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    started_at: timestamp("started_at", { withTimezone: true }).notNull(),
    service: text("service").notNull(),
    /** The route or job the call ran under; null outside a request or a job. */
    operation: text("operation"),
    request_id: text("request_id"),
    model_group: text("model_group").notNull(),
    model: text("model").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    error: text("error"),
    finish_reason: text("finish_reason"),
    attempt: integer("attempt").notNull(),
    fallback: boolean("fallback").notNull().default(false),
    ms: integer("ms").notNull(),
    input_tokens: integer("input_tokens"),
    output_tokens: integer("output_tokens"),
  },
  (t) => [index("model_call_started_at_idx").on(t.started_at)],
);
