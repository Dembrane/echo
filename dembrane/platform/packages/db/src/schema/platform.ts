import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
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
    provider: text("provider"),
    billing_account_id: uuid("billing_account_id"),
    project_id: uuid("project_id"),
    /** 'account' | 'internal' | 'unattributed'. */
    payer: text("payer").notNull().default("unattributed"),
    /** Whether the cost was added to the account's free_usage spend. */
    counted: boolean("counted").notNull().default(false),
    cached_input_tokens: integer("cached_input_tokens"),
    audio_input_tokens: integer("audio_input_tokens"),
    reasoning_tokens: integer("reasoning_tokens"),
    audio_seconds: real("audio_seconds"),
    search_queries: integer("search_queries"),
    usage_estimated: boolean("usage_estimated").notNull().default(false),
    price_missing: boolean("price_missing").notNull().default(false),
    cost_micro_eur: bigint("cost_micro_eur", { mode: "number" }),
    /** The ai_price row the cost came from. */
    price_id: bigint("price_id", { mode: "number" }),
  },
  (t) => [index("model_call_started_at_idx").on(t.started_at)],
);

/** Unit prices per model; a new row starts when any price changes, old rows stay for history. */
export const ai_price = pgTable(
  "ai_price",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    /** 'USD' | 'EUR'. */
    currency: text("currency").notNull(),
    input_per_m: numeric("input_per_m"),
    cached_input_per_m: numeric("cached_input_per_m"),
    audio_input_per_m: numeric("audio_input_per_m"),
    output_per_m: numeric("output_per_m"),
    /** Input tokens above which the long_* prices apply. */
    long_context_threshold: integer("long_context_threshold"),
    long_input_per_m: numeric("long_input_per_m"),
    long_cached_input_per_m: numeric("long_cached_input_per_m"),
    long_output_per_m: numeric("long_output_per_m"),
    per_audio_second: numeric("per_audio_second"),
    per_search_query: numeric("per_search_query"),
    /** 'models.dev' | 'override'. */
    source: text("source").notNull(),
    effective_from: timestamp("effective_from", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("ai_price_provider_model_effective_from").on(t.provider, t.model, t.effective_from),
  ],
);

/** ECB USD to EUR rate per day. */
export const ai_fx_rate = pgTable("ai_fx_rate", {
  day: date("day").primaryKey(),
  usd_to_eur: numeric("usd_to_eur").notNull(),
  fetched_at: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});

/** model_call rolled up per UTC day, account, payer, operation and model; kept after model_call is pruned. */
export const ai_spend_daily = pgTable(
  "ai_spend_daily",
  {
    day: date("day").notNull(),
    /** Null for unattributed spend. */
    billing_account_id: uuid("billing_account_id"),
    /** 'account' | 'internal' | 'unattributed', as on model_call. */
    payer: text("payer").notNull().default("unattributed"),
    operation: text("operation").notNull().default(""),
    model: text("model").notNull(),
    calls: integer("calls").notNull(),
    input_tokens: bigint("input_tokens", { mode: "number" }).notNull(),
    output_tokens: bigint("output_tokens", { mode: "number" }).notNull(),
    cost_micro_eur: bigint("cost_micro_eur", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("ai_spend_daily_key").on(
      t.day,
      sql`coalesce(${t.billing_account_id}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      t.payer,
      t.operation,
      t.model,
    ),
    index("ai_spend_daily_billing_account_idx").on(t.billing_account_id),
  ],
);

/** The backend's AI feature rules in order, filled at worker start; obs.ai_feature() reads them. */
export const ai_feature_rule = pgTable("ai_feature_rule", {
  position: integer("position").primaryKey(),
  pattern: text("pattern").notNull(),
  feature_group: text("feature_group").notNull(),
  group_label: text("group_label").notNull(),
  feature: text("feature").notNull(),
});

/** One limit per tier and key; staff edit them, so each row keeps who changed it last. */
export const tier_limit = pgTable(
  "tier_limit",
  {
    tier: text("tier").notNull(),
    key: text("key").notNull(),
    value: bigint("value", { mode: "number" }).notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    updated_by: uuid("updated_by"),
  },
  (t) => [primaryKey({ columns: [t.tier, t.key] })],
);

/** What a free billing account has used per period and key; deletes never decrement it. */
export const free_usage = pgTable(
  "free_usage",
  {
    billing_account_id: uuid("billing_account_id").notNull(),
    period_start: timestamp("period_start", { withTimezone: true, mode: "string" }).notNull(),
    key: text("key").notNull(),
    amount: bigint("amount", { mode: "number" }).notNull().default(0),
    updated_at: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.billing_account_id, t.period_start, t.key] })],
);

/**
 * Product milestones a host reached, once each (packages/conversations host-events.ts).
 * The primary key is the claim: of two concurrent conversations exactly one inserts the
 * row, so the analytics event for a milestone is sent once per host however often a
 * step is retried.
 */
export const host_milestone = pgTable(
  "host_milestone",
  {
    directus_user_id: uuid("directus_user_id").notNull(),
    /** "first_value": the first conversation captured in a project the host created. */
    milestone: text("milestone").notNull(),
    /** The project it was reached in; no foreign key, so a deleted project keeps the row. */
    project_id: uuid("project_id"),
    reached_at: timestamp("reached_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.directus_user_id, t.milestone] })],
);
