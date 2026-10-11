// Baseline: the schema of echo main as deployed on echo-next, read by drizzle-kit and
// corrected where introspection is lossy (operator classes, unsized vector, extension
// views). Functions and triggers live in migrations/0000_baseline_guards.sql because
// Drizzle does not model them. Proven by scripts/schema-roundtrip.sh.

import type { PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  json,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/** pgvector column without a fixed size; map_embedding stores its size in `dims` and checks it. */
const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => "vector",
  toDriver: (v) => `[${v.join(",")}]`,
  fromDriver: (v) => JSON.parse(v),
});

import { sql } from "drizzle-orm";

export const analysis_last_opened = pgTable(
  "analysis_last_opened",
  {
    id: uuid().primaryKey().notNull(),
    opened_at: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    project_id: uuid().notNull(),
    user_id: varchar({ length: 64 }).default(sql`NULL`).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("analysis_last_opened_project_user").using(
      "btree",
      table.project_id.asc().nullsLast(),
      table.user_id.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.project_id],
      foreignColumns: [project.id],
      name: "analysis_last_opened_project_id_foreign",
    }).onDelete("cascade"),
    check("analysis_last_opened_user_present", sql`length(btrim((user_id)::text)) > 0`),
  ],
);

export const agent_memory = pgTable("agent_memory", {
  content: text(),
  created_at: timestamp({ withTimezone: true, mode: "string" }),
  directus_user_id: varchar({ length: 255 }).default(sql`NULL`),
  id: uuid().primaryKey().notNull(),
  memory_key: varchar({ length: 255 }).default(sql`NULL`),
  project_id: varchar({ length: 255 }).default(sql`NULL`),
  scope: varchar({ length: 255 }).default("project"),
  source: varchar({ length: 255 }).default("agent"),
  updated_at: timestamp({ withTimezone: true, mode: "string" }),
  workspace_id: varchar({ length: 255 }).default(sql`NULL`),
});

export const agent_audit_event = pgTable(
  "agent_audit_event",
  {
    app_user_id: uuid().notNull(),
    client_id: uuid().notNull(),
    created_at: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    duration_ms: integer(),
    grant_id: uuid().notNull(),
    id: uuid().primaryKey().notNull(),
    org_id: uuid(),
    params: json(),
    status: varchar({ length: 255 }).default(sql`NULL`).notNull(),
    tool: varchar({ length: 255 }).default(sql`NULL`).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index().using("btree", table.app_user_id.asc().nullsLast()),
    index().using("btree", table.client_id.asc().nullsLast()),
    index().using("btree", table.created_at.asc().nullsLast()),
    index().using("btree", table.grant_id.asc().nullsLast()),
    index().using("btree", table.org_id.asc().nullsLast()),
    index().using("btree", table.tool.asc().nullsLast()),
  ],
);

export const agent_client = pgTable("agent_client", {
  client_name: varchar({ length: 255 }).default(sql`NULL`),
  client_secret_encrypted: text(),
  created_at: timestamp({ withTimezone: true, mode: "string" }).notNull(),
  id: uuid().primaryKey().notNull(),
  last_seen_at: timestamp({ withTimezone: true, mode: "string" }),
  metadata: json(),
  redirect_uris: json(),
  token_endpoint_auth_method: varchar({ length: 255 }).default(sql`NULL`),
});

export const agent_grant = pgTable(
  "agent_grant",
  {
    app_user_id: uuid().notNull(),
    client_id: uuid().notNull(),
    client_name: varchar({ length: 255 }).default(sql`NULL`),
    consent_accepted_at: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    consent_version: varchar({ length: 255 }).default(sql`NULL`),
    created_at: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    directus_user_id: uuid().notNull(),
    expires_at: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    id: uuid().primaryKey().notNull(),
    last_used_at: timestamp({ withTimezone: true, mode: "string" }),
    org_ids: json(),
    revoked_at: timestamp({ withTimezone: true, mode: "string" }),
    scopes: json(),
  },
  (table): PgTableExtraConfigValue[] => [
    index().using("btree", table.app_user_id.asc().nullsLast()),
    index().using("btree", table.client_id.asc().nullsLast()),
    index().using("btree", table.directus_user_id.asc().nullsLast()),
    index().using("btree", table.expires_at.asc().nullsLast()),
    index().using("btree", table.revoked_at.asc().nullsLast()),
  ],
);

export const agent_insight = pgTable("agent_insight", {
  id: uuid().primaryKey().notNull(),
  created_at: timestamp({ withTimezone: true, mode: "string" }),
  kind: varchar({ length: 255 }).default(sql`NULL`).notNull(),
  content: text().notNull(),
  suggested_capability: text(),
  workspace_id: varchar({ length: 255 }).default(sql`NULL`),
  project_id: varchar({ length: 255 }).default(sql`NULL`),
  chat_id: varchar({ length: 255 }).default(sql`NULL`),
  message_id: varchar({ length: 255 }).default(sql`NULL`),
  status: varchar({ length: 255 }).default("new"),
  source: varchar({ length: 255 }).default(sql`NULL`),
});

export const agent_loop_run = pgTable(
  "agent_loop_run",
  {
    detail: text(),
    finished_at: timestamp({ withTimezone: true, mode: "string" }),
    generation_id: uuid(),
    id: uuid().primaryKey().notNull(),
    loop_id: uuid(),
    started_at: timestamp({ withTimezone: true, mode: "string" }),
    status: varchar({ length: 255 }).default(sql`NULL`),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.generation_id],
      foreignColumns: [canvas_generation.id],
      name: "agent_loop_run_generation_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.loop_id],
      foreignColumns: [agent_loop.id],
      name: "agent_loop_run_loop_id_foreign",
    }).onDelete("set null"),
  ],
);

export const agent_token = pgTable(
  "agent_token",
  {
    created_at: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    expires_at: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    grant_id: uuid().notNull(),
    id: uuid().primaryKey().notNull(),
    kind: varchar({ length: 255 }).default(sql`NULL`).notNull(),
    pair_id: uuid().notNull(),
    revoked_at: timestamp({ withTimezone: true, mode: "string" }),
    token_hash: varchar({ length: 255 }).default(sql`NULL`).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index().using("btree", table.expires_at.asc().nullsLast()),
    index().using("btree", table.grant_id.asc().nullsLast()),
    index().using("btree", table.pair_id.asc().nullsLast()),
    index().using("btree", table.revoked_at.asc().nullsLast()),
    index().using("btree", table.token_hash.asc().nullsLast()),
    unique("agent_token_token_hash_unique").on(table.token_hash),
  ],
);

export const analysis_object_revision = pgTable(
  "analysis_object_revision",
  {
    actor_id: varchar({ length: 64 }).default(sql`NULL`),
    attributes: json(),
    content_hash: varchar({ length: 64 }).default(sql`NULL`).notNull(),
    created_at: timestamp({ withTimezone: true, mode: "string" }),
    embedding_refs: json(),
    hash_version: varchar({ length: 16 }).default("c14n-v1").notNull(),
    id: uuid().primaryKey().notNull(),
    object_id: uuid().notNull(),
    origin: varchar({ length: 16 }).default(sql`NULL`).notNull(),
    parent_revision_id: uuid(),
    payload: json().notNull(),
    project_id: uuid().notNull(),
    provenance: json().notNull(),
    published_at: timestamp({ withTimezone: true, mode: "string" }),
    reason: text(),
    revision_number: integer().notNull(),
    run_id: uuid(),
    schema_version: integer().notNull(),
    status: varchar({ length: 16 }).default(sql`NULL`).notNull(),
    type: varchar({ length: 64 }).default(sql`NULL`).notNull(),
    change_kind: varchar({ length: 16 }).default(sql`NULL`),
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("analysis_object_revision_object_number").using(
      "btree",
      table.object_id.asc().nullsLast(),
      table.revision_number.asc().nullsLast(),
    ),
    uniqueIndex("analysis_object_revision_one_staged_per_run")
      .using("btree", table.run_id.asc().nullsLast(), table.object_id.asc().nullsLast())
      .where(
        sql`((status)::text = ANY (ARRAY[('staged'::character varying)::text, ('candidate'::character varying)::text]))`,
      ),
    index("analysis_object_revision_run_status").using(
      "btree",
      table.run_id.asc().nullsLast(),
      table.status.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.object_id],
      foreignColumns: [analysis_object.id],
      name: "analysis_object_revision_object_id_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.parent_revision_id],
      foreignColumns: [table.id],
      name: "analysis_object_revision_parent_revision_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.project_id],
      foreignColumns: [project.id],
      name: "analysis_object_revision_project_id_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.run_id],
      foreignColumns: [analysis_run.id],
      name: "analysis_object_revision_run_id_foreign",
    }).onDelete("set null"),
    check(
      "analysis_object_revision_change_kind_authored",
      sql`(change_kind IS NULL) OR ((origin)::text = 'authored'::text)`,
    ),
    check(
      "analysis_object_revision_change_kind_valid",
      sql`(change_kind IS NULL) OR ((change_kind)::text = ANY (ARRAY[('typo'::character varying)::text, ('clarity'::character varying)::text, ('meaning'::character varying)::text, ('withdraw'::character varying)::text, ('restore'::character varying)::text, ('rollback'::character varying)::text]))`,
    ),
    check(
      "analysis_object_revision_generated_provenance",
      sql`((origin)::text <> 'generated'::text) OR ((((provenance)::jsonb ->> 'runId'::text) IS NOT NULL) AND (((provenance)::jsonb ->> 'recipeId'::text) IS NOT NULL))`,
    ),
    check(
      "analysis_object_revision_hash_version_valid",
      sql`(hash_version)::text = 'c14n-v1'::text`,
    ),
    check(
      "analysis_object_revision_numbers_valid",
      sql`(revision_number >= 1) AND (schema_version >= 1)`,
    ),
    check(
      "analysis_object_revision_origin_valid",
      sql`(origin)::text = ANY (ARRAY[('generated'::character varying)::text, ('authored'::character varying)::text, ('imported'::character varying)::text])`,
    ),
    check(
      "analysis_object_revision_published_at",
      sql`((status)::text <> 'published'::text) OR (published_at IS NOT NULL)`,
    ),
    check(
      "analysis_object_revision_status_valid",
      sql`(status)::text = ANY (ARRAY[('staged'::character varying)::text, ('candidate'::character varying)::text, ('published'::character varying)::text, ('discarded'::character varying)::text])`,
    ),
  ],
);

export const analysis_object = pgTable(
  "analysis_object",
  {
    created_at: timestamp({ withTimezone: true, mode: "string" }),
    current_revision_id: uuid(),
    id: uuid().primaryKey().notNull(),
    lineage_key: varchar({ length: 255 }).default(sql`NULL`).notNull(),
    project_id: uuid().notNull(),
    revision_count: integer().default(0).notNull(),
    scope_id: uuid(),
    type: varchar({ length: 64 }).default(sql`NULL`).notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" }),
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("analysis_object_project_lineage").using(
      "btree",
      table.project_id.asc().nullsLast(),
      table.type.asc().nullsLast(),
      table.lineage_key.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.current_revision_id],
      foreignColumns: [analysis_object_revision.id],
      name: "analysis_object_current_revision_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.project_id],
      foreignColumns: [project.id],
      name: "analysis_object_project_id_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.scope_id],
      foreignColumns: [analysis_scope.id],
      name: "analysis_object_scope_id_foreign",
    }).onDelete("set null"),
    check("analysis_object_revision_count_valid", sql`revision_count >= 0`),
  ],
);

export const analysis_feedback = pgTable(
  "analysis_feedback",
  {
    actor_id: varchar({ length: 64 }).default(sql`NULL`).notNull(),
    created_at: timestamp({ withTimezone: true, mode: "string" }),
    id: uuid().primaryKey().notNull(),
    note: text(),
    object_id: uuid().notNull(),
    project_id: uuid().notNull(),
    rating: varchar({ length: 8 }).default(sql`NULL`).notNull(),
    revision_id: uuid().notNull(),
    tags: json().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" }),
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("analysis_feedback_project_object_actor").using(
      "btree",
      table.project_id.asc().nullsLast(),
      table.object_id.asc().nullsLast(),
      table.actor_id.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.object_id],
      foreignColumns: [analysis_object.id],
      name: "analysis_feedback_object_id_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.project_id],
      foreignColumns: [project.id],
      name: "analysis_feedback_project_id_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.revision_id],
      foreignColumns: [analysis_object_revision.id],
      name: "analysis_feedback_revision_id_foreign",
    }).onDelete("cascade"),
    check("analysis_feedback_actor_present", sql`length(btrim((actor_id)::text)) > 0`),
    check("analysis_feedback_note_length", sql`(note IS NULL) OR (length(note) <= 500)`),
    check(
      "analysis_feedback_rating_valid",
      sql`(rating)::text = ANY (ARRAY[('up'::character varying)::text, ('down'::character varying)::text])`,
    ),
    check("analysis_feedback_tags_are_an_array", sql`json_typeof(tags) = 'array'::text`),
  ],
);

export const analysis_outbox = pgTable(
  "analysis_outbox",
  {
    attempts: integer().default(0).notNull(),
    claim: varchar({ length: 64 }).default(sql`NULL`),
    consumers: json(),
    created_at: timestamp({ withTimezone: true, mode: "string" }),
    delivered_at: timestamp({ withTimezone: true, mode: "string" }),
    event_type: varchar({ length: 64 }).default(sql`NULL`).notNull(),
    id: uuid().primaryKey().notNull(),
    last_error: text(),
    next_attempt_at: timestamp({ withTimezone: true, mode: "string" }),
    payload: json(),
    project_id: uuid().notNull(),
    run_id: uuid(),
    scope_id: uuid().notNull(),
    sequence: integer().notNull(),
    snapshot_id: uuid(),
    status: varchar({ length: 16 }).default("pending").notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" }),
  },
  (table): PgTableExtraConfigValue[] => [
    index("analysis_outbox_due")
      .using("btree", table.next_attempt_at.asc().nullsLast(), table.created_at.asc().nullsLast())
      .where(
        sql`((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('dispatching'::character varying)::text]))`,
      ),
    uniqueIndex("analysis_outbox_scope_sequence").using(
      "btree",
      table.scope_id.asc().nullsLast(),
      table.sequence.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.project_id],
      foreignColumns: [project.id],
      name: "analysis_outbox_project_id_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.run_id],
      foreignColumns: [analysis_run.id],
      name: "analysis_outbox_run_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.scope_id],
      foreignColumns: [analysis_scope.id],
      name: "analysis_outbox_scope_id_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.snapshot_id],
      foreignColumns: [analysis_snapshot.id],
      name: "analysis_outbox_snapshot_id_foreign",
    }).onDelete("set null"),
    check("analysis_outbox_counters_valid", sql`(sequence >= 1) AND (attempts >= 0)`),
    check(
      "analysis_outbox_status_valid",
      sql`(status)::text = ANY (ARRAY[('pending'::character varying)::text, ('dispatching'::character varying)::text, ('delivered'::character varying)::text, ('dead'::character varying)::text])`,
    ),
  ],
);

export const access_request = pgTable(
  "access_request",
  {
    actioned_at: timestamp({ withTimezone: true, mode: "string" }),
    actioned_by: uuid(),
    deleted_at: timestamp({ withTimezone: true, mode: "string" }),
    id: uuid().primaryKey().notNull(),
    requested_at: timestamp({ withTimezone: true, mode: "string" })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    status: varchar({ length: 255 }).default("pending").notNull(),
    user_id: uuid().notNull(),
    workspace_id: uuid().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.actioned_by],
      foreignColumns: [app_user.id],
      name: "access_request_actioned_by_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.user_id],
      foreignColumns: [app_user.id],
      name: "access_request_user_id_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspace_id],
      foreignColumns: [workspace.id],
      name: "access_request_workspace_id_foreign",
    }).onDelete("cascade"),
  ],
);

export const agent_loop = pgTable(
  "agent_loop",
  {
    acting_directus_user_id: varchar({ length: 255 }).default(sql`NULL`),
    cadence_minutes: integer().default(5),
    caps: json(),
    chat_id: varchar({ length: 255 }).default(sql`NULL`),
    created_at: timestamp({ withTimezone: true, mode: "string" }),
    created_from_chat_id: varchar({ length: 255 }).default(sql`NULL`),
    expires_at: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    failure_count: integer().default(0),
    id: uuid().primaryKey().notNull(),
    name: varchar({ length: 255 }).default(sql`NULL`),
    project_id: uuid(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    report_id: bigint({ mode: "number" }),
    status: varchar({ length: 255 }).default("active"),
    updated_at: timestamp({ withTimezone: true, mode: "string" }),
    popcorn_state: json(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.project_id],
      foreignColumns: [project.id],
      name: "agent_loop_project_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.report_id],
      foreignColumns: [project_report.id],
      name: "agent_loop_report_id_foreign",
    }).onDelete("set null"),
  ],
);

export const analysis_run = pgTable(
  "analysis_run",
  {
    attempt: integer().default(0).notNull(),
    checks: json(),
    completed_at: timestamp({ withTimezone: true, mode: "string" }),
    context: json(),
    created_at: timestamp({ withTimezone: true, mode: "string" }),
    definition: json().notNull(),
    depends_on: json(),
    epoch: integer().default(0).notNull(),
    error: text(),
    execution_ref: varchar({ length: 128 }).default(sql`NULL`),
    hash_version: varchar({ length: 16 }).default("c14n-v1").notNull(),
    id: uuid().primaryKey().notNull(),
    idempotency_key: varchar({ length: 255 }).default(sql`NULL`).notNull(),
    input_fingerprint: varchar({ length: 64 }).default(sql`NULL`),
    input_manifest: json(),
    lease: varchar({ length: 64 }).default(sql`NULL`),
    lease_expires_at: timestamp({ withTimezone: true, mode: "string" }),
    metrics: json(),
    mode: varchar({ length: 16 }).default(sql`NULL`).notNull(),
    output_manifest: json(),
    parameters: json(),
    progress: json(),
    project_id: uuid().notNull(),
    recipe_id: varchar({ length: 128 }).default(sql`NULL`).notNull(),
    recipe_version: varchar({ length: 64 }).default(sql`NULL`).notNull(),
    request_fingerprint: varchar({ length: 64 }).default(sql`NULL`).notNull(),
    request_order: integer().notNull(),
    requested_by: varchar({ length: 64 }).default(sql`NULL`),
    reused_run_id: uuid(),
    scope_id: uuid().notNull(),
    started_at: timestamp({ withTimezone: true, mode: "string" }),
    status: varchar({ length: 32 }).default(sql`NULL`).notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" }),
    writer_fence: integer().default(0).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("analysis_run_one_active_request")
      .using("btree", table.scope_id.asc().nullsLast(), table.request_fingerprint.asc().nullsLast())
      .where(
        sql`((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('waiting_for_inputs'::character varying)::text, ('running'::character varying)::text]))`,
      ),
    uniqueIndex("analysis_run_project_idempotency").using(
      "btree",
      table.project_id.asc().nullsLast(),
      table.idempotency_key.asc().nullsLast(),
    ),
    index("analysis_run_running_expiry")
      .using("btree", table.lease_expires_at.asc().nullsLast(), table.id.asc().nullsLast())
      .where(sql`((status)::text = 'running'::text)`),
    index("analysis_run_running_lease")
      .using("btree", table.recipe_id.asc().nullsLast(), table.lease_expires_at.asc().nullsLast())
      .where(sql`((status)::text = 'running'::text)`),
    uniqueIndex("analysis_run_scope_request_order").using(
      "btree",
      table.scope_id.asc().nullsLast(),
      table.request_order.asc().nullsLast(),
    ),
    index("analysis_run_scope_status_created").using(
      "btree",
      table.scope_id.asc().nullsLast(),
      table.status.asc().nullsLast(),
      table.created_at.desc().nullsFirst(),
    ),
    index("analysis_run_waiting_by_project")
      .using("btree", table.project_id.asc().nullsLast(), table.created_at.asc().nullsLast())
      .where(sql`((status)::text = 'waiting_for_inputs'::text)`),
    foreignKey({
      columns: [table.project_id],
      foreignColumns: [project.id],
      name: "analysis_run_project_id_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.reused_run_id],
      foreignColumns: [table.id],
      name: "analysis_run_reused_run_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.scope_id],
      foreignColumns: [analysis_scope.id],
      name: "analysis_run_scope_id_foreign",
    }).onDelete("cascade"),
    check(
      "analysis_run_counters_valid",
      sql`(request_order >= 1) AND (epoch >= 0) AND (attempt >= 0)`,
    ),
    check("analysis_run_hash_version_valid", sql`(hash_version)::text = 'c14n-v1'::text`),
    check(
      "analysis_run_mode_valid",
      sql`(mode)::text = ANY (ARRAY[('refresh'::character varying)::text, ('regenerate'::character varying)::text, ('retry'::character varying)::text])`,
    ),
    check(
      "analysis_run_ready_has_manifest",
      sql`((status)::text <> 'ready'::text) OR (output_manifest IS NOT NULL)`,
    ),
    check(
      "analysis_run_running_has_lease",
      sql`((status)::text <> 'running'::text) OR ((lease IS NOT NULL) AND (lease_expires_at IS NOT NULL))`,
    ),
    check(
      "analysis_run_status_valid",
      sql`(status)::text = ANY (ARRAY[('queued'::character varying)::text, ('waiting_for_inputs'::character varying)::text, ('running'::character varying)::text, ('needs_review'::character varying)::text, ('ready'::character varying)::text, ('failed'::character varying)::text, ('cancelled'::character varying)::text, ('superseded'::character varying)::text])`,
    ),
    check("analysis_run_writer_fence_valid", sql`writer_fence >= 0`),
  ],
);

export const analysis_scope = pgTable(
  "analysis_scope",
  {
    created_at: timestamp({ withTimezone: true, mode: "string" }),
    current_request_order: integer(),
    current_run_id: uuid(),
    current_snapshot_id: uuid(),
    generation_epoch: integer().default(0).notNull(),
    id: uuid().primaryKey().notNull(),
    kind: varchar({ length: 16 }).default(sql`NULL`).notNull(),
    next_request_order: integer().default(1).notNull(),
    project_id: uuid().notNull(),
    publication_sequence: integer().default(0).notNull(),
    recipe_id: varchar({ length: 128 }).default(sql`NULL`),
    scope_key: varchar({ length: 255 }).default(sql`NULL`).notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" }),
    view_id: varchar({ length: 128 }).default(sql`NULL`),
    writer: varchar({ length: 16 }).default("analysis").notNull(),
    writer_fence: integer().default(0).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("analysis_scope_producer_identity")
      .using(
        "btree",
        table.project_id.asc().nullsLast(),
        table.recipe_id.asc().nullsLast(),
        table.scope_key.asc().nullsLast(),
      )
      .where(sql`((kind)::text = 'producer'::text)`),
    uniqueIndex("analysis_scope_view_identity")
      .using(
        "btree",
        table.project_id.asc().nullsLast(),
        table.view_id.asc().nullsLast(),
        table.scope_key.asc().nullsLast(),
      )
      .where(sql`((kind)::text = 'view'::text)`),
    foreignKey({
      columns: [table.current_run_id],
      foreignColumns: [analysis_run.id],
      name: "analysis_scope_current_run_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.current_snapshot_id],
      foreignColumns: [analysis_snapshot.id],
      name: "analysis_scope_current_snapshot_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.project_id],
      foreignColumns: [project.id],
      name: "analysis_scope_project_id_foreign",
    }).onDelete("cascade"),
    check(
      "analysis_scope_counters_valid",
      sql`(next_request_order >= 1) AND (generation_epoch >= 0) AND (publication_sequence >= 0) AND (writer_fence >= 0) AND ((current_request_order IS NULL) OR (current_request_order >= 1))`,
    ),
    check(
      "analysis_scope_kind_valid",
      sql`(((kind)::text = 'producer'::text) AND (recipe_id IS NOT NULL) AND (view_id IS NULL) AND (current_snapshot_id IS NULL)) OR (((kind)::text = 'view'::text) AND (view_id IS NOT NULL) AND (recipe_id IS NULL) AND (current_run_id IS NULL))`,
    ),
    check(
      "analysis_scope_writer_valid",
      sql`(writer)::text = ANY (ARRAY[('legacy'::character varying)::text, ('analysis'::character varying)::text])`,
    ),
  ],
);

export const analysis_snapshot = pgTable(
  "analysis_snapshot",
  {
    content_hash: varchar({ length: 64 }).default(sql`NULL`).notNull(),
    created_at: timestamp({ withTimezone: true, mode: "string" }),
    created_by: varchar({ length: 64 }).default(sql`NULL`),
    embedding_config: json(),
    hash_version: varchar({ length: 16 }).default("c14n-v1").notNull(),
    id: uuid().primaryKey().notNull(),
    manifest: json().notNull(),
    manifest_version: integer().default(1).notNull(),
    parent_snapshot_id: uuid(),
    project_id: uuid().notNull(),
    scope_id: uuid().notNull(),
    settings: json(),
    source_event_id: uuid(),
    versions: json(),
    view_id: varchar({ length: 128 }).default(sql`NULL`).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("analysis_snapshot_scope_created").using(
      "btree",
      table.scope_id.asc().nullsLast(),
      table.created_at.desc().nullsFirst(),
    ),
    uniqueIndex("analysis_snapshot_scope_source_event")
      .using("btree", table.scope_id.asc().nullsLast(), table.source_event_id.asc().nullsLast())
      .where(sql`(source_event_id IS NOT NULL)`),
    foreignKey({
      columns: [table.parent_snapshot_id],
      foreignColumns: [table.id],
      name: "analysis_snapshot_parent_snapshot_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.project_id],
      foreignColumns: [project.id],
      name: "analysis_snapshot_project_id_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.scope_id],
      foreignColumns: [analysis_scope.id],
      name: "analysis_snapshot_scope_id_foreign",
    }).onDelete("cascade"),
    check("analysis_snapshot_hash_version_valid", sql`(hash_version)::text = 'c14n-v1'::text`),
    check("analysis_snapshot_manifest_version_valid", sql`manifest_version >= 1`),
  ],
);

export const analysis_relation = pgTable(
  "analysis_relation",
  {
    attributes: json(),
    basis: varchar({ length: 16 }).default(sql`NULL`).notNull(),
    content_hash: varchar({ length: 64 }).default(sql`NULL`).notNull(),
    created_at: timestamp({ withTimezone: true, mode: "string" }),
    from_object_id: uuid().notNull(),
    from_revision_id: uuid().notNull(),
    hash_version: varchar({ length: 16 }).default("c14n-v1").notNull(),
    id: uuid().primaryKey().notNull(),
    project_id: uuid().notNull(),
    provenance: json(),
    published_at: timestamp({ withTimezone: true, mode: "string" }),
    run_id: uuid(),
    status: varchar({ length: 16 }).default(sql`NULL`).notNull(),
    to_object_id: uuid().notNull(),
    to_revision_id: uuid().notNull(),
    type: varchar({ length: 64 }).default(sql`NULL`).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("analysis_relation_one_staged_per_run")
      .using(
        "btree",
        table.run_id.asc().nullsLast(),
        table.type.asc().nullsLast(),
        table.from_revision_id.asc().nullsLast(),
        table.to_revision_id.asc().nullsLast(),
      )
      .where(sql`((status)::text = 'staged'::text)`),
    index("analysis_relation_published_from")
      .using("btree", table.from_revision_id.asc().nullsLast(), table.type.asc().nullsLast())
      .where(sql`((status)::text = 'published'::text)`),
    index("analysis_relation_published_to")
      .using("btree", table.to_revision_id.asc().nullsLast(), table.type.asc().nullsLast())
      .where(sql`((status)::text = 'published'::text)`),
    index("analysis_relation_run_status").using(
      "btree",
      table.run_id.asc().nullsLast(),
      table.status.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.from_object_id],
      foreignColumns: [analysis_object.id],
      name: "analysis_relation_from_object_id_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.from_revision_id],
      foreignColumns: [analysis_object_revision.id],
      name: "analysis_relation_from_revision_id_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.project_id],
      foreignColumns: [project.id],
      name: "analysis_relation_project_id_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.run_id],
      foreignColumns: [analysis_run.id],
      name: "analysis_relation_run_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.to_object_id],
      foreignColumns: [analysis_object.id],
      name: "analysis_relation_to_object_id_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.to_revision_id],
      foreignColumns: [analysis_object_revision.id],
      name: "analysis_relation_to_revision_id_foreign",
    }).onDelete("cascade"),
    check(
      "analysis_relation_basis_valid",
      sql`(basis)::text = ANY (ARRAY[('extracted'::character varying)::text, ('inferred'::character varying)::text, ('authored'::character varying)::text])`,
    ),
    check("analysis_relation_hash_version_valid", sql`(hash_version)::text = 'c14n-v1'::text`),
    check("analysis_relation_not_reflexive", sql`from_revision_id <> to_revision_id`),
    check(
      "analysis_relation_status_valid",
      sql`(status)::text = ANY (ARRAY[('staged'::character varying)::text, ('published'::character varying)::text, ('discarded'::character varying)::text])`,
    ),
  ],
);

export const analysis_step = pgTable(
  "analysis_step",
  {
    attempt: integer().default(1).notNull(),
    cache_key: varchar({ length: 64 }).default(sql`NULL`).notNull(),
    checkpoint: json(),
    completed_at: timestamp({ withTimezone: true, mode: "string" }),
    created_at: timestamp({ withTimezone: true, mode: "string" }),
    error: text(),
    hash_version: varchar({ length: 16 }).default("c14n-v1").notNull(),
    id: uuid().primaryKey().notNull(),
    kind: varchar({ length: 16 }).default(sql`NULL`).notNull(),
    lease: varchar({ length: 64 }).default(sql`NULL`),
    output: json(),
    project_id: uuid().notNull(),
    reused_step_id: uuid(),
    run_id: uuid().notNull(),
    status: varchar({ length: 16 }).default(sql`NULL`).notNull(),
    step_key: varchar({ length: 128 }).default(sql`NULL`).notNull(),
    step_version: varchar({ length: 64 }).default(sql`NULL`).notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" }),
    usage: json(),
    validation: json(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("analysis_step_project_cache")
      .using(
        "btree",
        table.project_id.asc().nullsLast(),
        table.cache_key.asc().nullsLast(),
        table.completed_at.desc().nullsFirst(),
      )
      .where(sql`(((status)::text = 'completed'::text) AND (reused_step_id IS NULL))`),
    uniqueIndex("analysis_step_run_step").using(
      "btree",
      table.run_id.asc().nullsLast(),
      table.step_key.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.project_id],
      foreignColumns: [project.id],
      name: "analysis_step_project_id_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.reused_step_id],
      foreignColumns: [table.id],
      name: "analysis_step_reused_step_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.run_id],
      foreignColumns: [analysis_run.id],
      name: "analysis_step_run_id_foreign",
    }).onDelete("cascade"),
    check("analysis_step_attempt_valid", sql`attempt >= 1`),
    check("analysis_step_hash_version_valid", sql`(hash_version)::text = 'c14n-v1'::text`),
    check(
      "analysis_step_kind_valid",
      sql`(kind)::text = ANY (ARRAY[('model'::character varying)::text, ('deterministic'::character varying)::text, ('check'::character varying)::text])`,
    ),
    check(
      "analysis_step_status_valid",
      sql`(status)::text = ANY (ARRAY[('running'::character varying)::text, ('completed'::character varying)::text, ('failed'::character varying)::text])`,
    ),
  ],
);

export const analysis_request_key = pgTable(
  "analysis_request_key",
  {
    created_at: timestamp({ withTimezone: true, mode: "string" }),
    id: uuid().primaryKey().notNull(),
    idempotency_key: varchar({ length: 255 }).default(sql`NULL`).notNull(),
    mode: varchar({ length: 16 }).default(sql`NULL`).notNull(),
    project_id: uuid().notNull(),
    run_id: uuid().notNull(),
    scope_id: uuid().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("analysis_request_key_project_key").using(
      "btree",
      table.project_id.asc().nullsLast(),
      table.idempotency_key.asc().nullsLast(),
    ),
    index("analysis_request_key_run").using(
      "btree",
      table.run_id.asc().nullsLast(),
      table.created_at.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.project_id],
      foreignColumns: [project.id],
      name: "analysis_request_key_project_id_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.run_id],
      foreignColumns: [analysis_run.id],
      name: "analysis_request_key_run_id_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.scope_id],
      foreignColumns: [analysis_scope.id],
      name: "analysis_request_key_scope_id_foreign",
    }).onDelete("cascade"),
    check(
      "analysis_request_key_mode_valid",
      sql`(mode)::text = ANY (ARRAY[('refresh'::character varying)::text, ('regenerate'::character varying)::text, ('retry'::character varying)::text])`,
    ),
  ],
);

export const announcement = pgTable(
  "announcement",
  {
    created_at: timestamp({ withTimezone: true, mode: "string" }),
    expires_at: timestamp({ mode: "string" }),
    id: uuid().primaryKey().notNull(),
    level: varchar({ length: 255 }).default(sql`NULL`),
    sort: integer(),
    updated_at: timestamp({ withTimezone: true, mode: "string" }),
    user_created: uuid(),
    user_updated: uuid(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.user_created],
      foreignColumns: [directus_users.id],
      name: "announcement_user_created_foreign",
    }),
    foreignKey({
      columns: [table.user_updated],
      foreignColumns: [directus_users.id],
      name: "announcement_user_updated_foreign",
    }),
  ],
);

export const announcement_translations = pgTable(
  "announcement_translations",
  {
    announcement_id: uuid(),
    id: serial().primaryKey().notNull(),
    languages_code: varchar({ length: 255 }).default(sql`NULL`),
    message: text(),
    title: text(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.announcement_id],
      foreignColumns: [announcement.id],
      name: "announcement_translations_announcement_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.languages_code],
      foreignColumns: [languages.code],
      name: "announcement_translations_languages_code_foreign",
    }).onDelete("set null"),
  ],
);

export const canvas_generation = pgTable(
  "canvas_generation",
  {
    config_revision_id: uuid(),
    content_html: text(),
    created_at: timestamp({ withTimezone: true, mode: "string" }),
    detail: text(),
    id: uuid().primaryKey().notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    report_id: bigint({ mode: "number" }),
    status: varchar({ length: 255 }).default("ok"),
    tick_kind: varchar({ length: 255 }).default(sql`NULL`),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.config_revision_id],
      foreignColumns: [canvas_config_revision.id],
      name: "canvas_generation_config_revision_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.report_id],
      foreignColumns: [project_report.id],
      name: "canvas_generation_report_id_foreign",
    }).onDelete("set null"),
  ],
);

export const billing_account = pgTable(
  "billing_account",
  {
    id: uuid().primaryKey().notNull(),
    billing_period: varchar({ length: 255 }).default(sql`NULL`),
    created_at: timestamp({ withTimezone: true, mode: "string" }).default(sql`CURRENT_TIMESTAMP`),
    created_by: uuid(),
    deleted_at: timestamp({ withTimezone: true, mode: "string" }),
    downgraded_at: timestamp({ withTimezone: true, mode: "string" }),
    downgraded_from_tier: varchar({ length: 255 }).default(sql`NULL`),
    label: varchar({ length: 255 }).default(sql`NULL`),
    mollie_customer_id: varchar({ length: 255 }).default(sql`NULL`),
    mollie_subscription_id: varchar({ length: 255 }).default(sql`NULL`),
    org_id: uuid(),
    payment_mode: varchar({ length: 255 }).default("none").notNull(),
    percent_discount: integer(),
    pre_warning_sent: boolean().default(false).notNull(),
    provisioned_seats: integer(),
    status: varchar({ length: 255 }).default("none"),
    tier: varchar({ length: 255 }).default("free").notNull(),
    tier_expires_at: timestamp({ withTimezone: true, mode: "string" }),
    type_discount: varchar({ length: 255 }).default(sql`NULL`),
    updated_at: timestamp({ withTimezone: true, mode: "string" }).default(sql`CURRENT_TIMESTAMP`),
    workspace_id: uuid(),
    account_manager_id: uuid(),
    billing_address_line1: varchar({ length: 255 }).default(sql`NULL`),
    billing_address_line2: varchar({ length: 255 }).default(sql`NULL`),
    billing_city: varchar({ length: 255 }).default(sql`NULL`),
    billing_country: varchar({ length: 255 }).default(sql`NULL`),
    billing_legal_name: varchar({ length: 255 }).default(sql`NULL`),
    billing_postal_code: varchar({ length: 255 }).default(sql`NULL`),
    billing_vat_id: varchar({ length: 255 }).default(sql`NULL`),
    billing_vat_region: varchar({ length: 255 }).default(sql`NULL`),
    payment_failed_notified: boolean().default(false).notNull(),
    reconcile_failed_at: timestamp({ withTimezone: true, mode: "string" }),
    // What Exact needs to invoice, confirmed by the customer when accepting an offer.
    kvk_number: varchar({ length: 255 }),
    kbo_number: varchar({ length: 255 }),
    billing_email: varchar({ length: 255 }),
    po_number: varchar({ length: 255 }),
    peppol_id: varchar({ length: 255 }),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.account_manager_id],
      foreignColumns: [app_user.id],
      name: "billing_account_account_manager_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.created_by],
      foreignColumns: [app_user.id],
      name: "billing_account_created_by_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.org_id],
      foreignColumns: [org.id],
      name: "billing_account_org_id_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspace_id],
      foreignColumns: [workspace.id],
      name: "billing_account_workspace_id_foreign",
    }).onDelete("cascade"),
  ],
);

export const canvas_config_revision = pgTable(
  "canvas_config_revision",
  {
    brief: text(),
    cadence_minutes: integer().default(5),
    created_at: timestamp({ withTimezone: true, mode: "string" }),
    created_by: varchar({ length: 255 }).default(sql`NULL`),
    gather_spec: json(),
    id: uuid().primaryKey().notNull(),
    note: varchar({ length: 255 }).default(sql`NULL`),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    report_id: bigint({ mode: "number" }),
    popcorn_settings: json(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.report_id],
      foreignColumns: [project_report.id],
      name: "canvas_config_revision_report_id_foreign",
    }).onDelete("set null"),
  ],
);

export const conversation = pgTable(
  "conversation",
  {
    created_at: timestamp({ withTimezone: true, mode: "string" }).default(sql`CURRENT_TIMESTAMP`),
    deleted_at: timestamp({ withTimezone: true, mode: "string" }),
    duration: real(),
    id: uuid().primaryKey().notNull(),
    is_all_chunks_transcribed: boolean(),
    is_anonymized: boolean().default(false),
    is_audio_processing_finished: boolean().default(false),
    is_finished: boolean().default(false),
    is_over_cap: boolean().default(false).notNull(),
    merged_audio_path: text(),
    merged_transcript: text(),
    participant_email: varchar({ length: 255 }).default(sql`NULL`),
    participant_name: varchar({ length: 255 }).default(sql`NULL`),
    participant_user_agent: varchar({ length: 255 }).default(sql`NULL`),
    project_id: uuid().notNull(),
    source: varchar({ length: 255 }).default(sql`NULL`),
    summary: text(),
    title: text(),
    updated_at: timestamp({ withTimezone: true, mode: "string" }).default(sql`CURRENT_TIMESTAMP`),
    move_history: json(),
    token_count: integer(),
    recording_started_at: timestamp({ withTimezone: true, mode: "string" }),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.project_id],
      foreignColumns: [project.id],
      name: "conversation_project_id_foreign",
    }).onDelete("cascade"),
  ],
);

export const conversation_artifact = pgTable(
  "conversation_artifact",
  {
    approved_at: timestamp({ withTimezone: true, mode: "string" }),
    content: text(),
    conversation_id: uuid(),
    date_created: timestamp({ withTimezone: true, mode: "string" }),
    id: uuid().primaryKey().notNull(),
    key: varchar({ length: 255 }).default(sql`NULL`),
    last_updated_at: timestamp({ mode: "string" }),
    read_aloud_stream_url: text(),
    topic_label: varchar({ length: 255 }).default(sql`NULL`),
    user_created: uuid(),
    user_updated: uuid(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.conversation_id],
      foreignColumns: [conversation.id],
      name: "conversation_artifact_conversation_id_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.user_created],
      foreignColumns: [directus_users.id],
      name: "conversation_artifact_user_created_foreign",
    }),
    foreignKey({
      columns: [table.user_updated],
      foreignColumns: [directus_users.id],
      name: "conversation_artifact_user_updated_foreign",
    }),
  ],
);

export const conversation_chunk = pgTable(
  "conversation_chunk",
  {
    conversation_id: uuid().notNull(),
    created_at: timestamp({ withTimezone: true, mode: "string" }).default(sql`CURRENT_TIMESTAMP`),
    cross_talk_instances: integer().default(0),
    desired_language: varchar({ length: 255 }).default(sql`NULL`),
    detected_language: varchar({ length: 255 }).default(sql`NULL`),
    detected_language_confidence: real(),
    diarization: json(),
    error: text(),
    hallucination_reason: text(),
    hallucination_score: real(),
    id: uuid().primaryKey().notNull(),
    noise_ratio: real().default(sql`'0'`),
    path: varchar({ length: 255 }).default(sql`NULL`),
    raw_transcript: text(),
    runpod_job_status_link: text(),
    runpod_request_count: integer().default(0),
    silence_ratio: real().default(sql`'0'`),
    source: varchar({ length: 255 }).default(sql`NULL`),
    timestamp: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    transcript: text(),
    translation_error: varchar({ length: 255 }).default(sql`NULL`),
    updated_at: timestamp({ withTimezone: true, mode: "string" }).default(sql`CURRENT_TIMESTAMP`),
  },
  (table): PgTableExtraConfigValue[] => [
    index().using("btree", table.timestamp.asc().nullsLast()),
    foreignKey({
      columns: [table.conversation_id],
      foreignColumns: [conversation.id],
      name: "conversation_chunk_conversation_id_foreign",
    }).onDelete("cascade"),
  ],
);

export const conversation_link = pgTable(
  "conversation_link",
  {
    date_created: timestamp({ withTimezone: true, mode: "string" }),
    date_updated: timestamp({ withTimezone: true, mode: "string" }),
    id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
    link_type: varchar({ length: 255 }).default(sql`NULL`),
    source_conversation_id: uuid(),
    target_conversation_id: uuid(),
  },
  (table): PgTableExtraConfigValue[] => [
    index().using("btree", table.source_conversation_id.asc().nullsLast()),
    index().using("btree", table.target_conversation_id.asc().nullsLast()),
    foreignKey({
      columns: [table.source_conversation_id],
      foreignColumns: [conversation.id],
      name: "conversation_link_source_conversation_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.target_conversation_id],
      foreignColumns: [conversation.id],
      name: "conversation_link_target_conversation_id_foreign",
    }).onDelete("set null"),
  ],
);

export const conversation_project_tag = pgTable(
  "conversation_project_tag",
  {
    conversation_id: uuid(),
    id: serial().primaryKey().notNull(),
    project_tag_id: uuid(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.conversation_id],
      foreignColumns: [conversation.id],
      name: "conversation_project_tag_conversation_id_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.project_tag_id],
      foreignColumns: [project_tag.id],
      name: "conversation_project_tag_project_tag_id_foreign",
    }).onDelete("cascade"),
  ],
);

export const app_user = pgTable(
  "app_user",
  {
    created_at: timestamp({ withTimezone: true, mode: "string" }).default(sql`CURRENT_TIMESTAMP`),
    directus_user_id: uuid(),
    display_name: varchar({ length: 255 }).default(sql`NULL`),
    email: varchar({ length: 255 }).default(sql`NULL`),
    id: uuid().primaryKey().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" }).default(sql`CURRENT_TIMESTAMP`),
    onboarding_answer_json: json(),
    terms_accepted_at: timestamp({ withTimezone: true, mode: "string" }),
    settings: json(),
  },
  (table): PgTableExtraConfigValue[] => [
    unique("app_user_directus_user_id_unique").on(table.directus_user_id),
  ],
);

export const conversation_reply = pgTable(
  "conversation_reply",
  {
    content_text: text(),
    conversation_id: varchar({ length: 255 }).default(sql`NULL`),
    date_created: timestamp({ withTimezone: true, mode: "string" }),
    id: uuid().primaryKey().notNull(),
    reply: uuid(),
    sort: integer(),
    type: varchar({ length: 255 }).default(sql`NULL`),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.reply],
      foreignColumns: [conversation.id],
      name: "conversation_reply_reply_foreign",
    }).onDelete("set null"),
  ],
);

export const directus_comments = pgTable(
  "directus_comments",
  {
    id: uuid().primaryKey().notNull(),
    collection: varchar({ length: 64 }).notNull(),
    item: varchar({ length: 255 }).notNull(),
    comment: text().notNull(),
    date_created: timestamp({ withTimezone: true, mode: "string" }).default(sql`CURRENT_TIMESTAMP`),
    date_updated: timestamp({ withTimezone: true, mode: "string" }).default(sql`CURRENT_TIMESTAMP`),
    user_created: uuid(),
    user_updated: uuid(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.user_created],
      foreignColumns: [directus_users.id],
      name: "directus_comments_user_created_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.user_updated],
      foreignColumns: [directus_users.id],
      name: "directus_comments_user_updated_foreign",
    }),
  ],
);

export const directus_dashboards = pgTable(
  "directus_dashboards",
  {
    id: uuid().primaryKey().notNull(),
    name: varchar({ length: 255 }).notNull(),
    icon: varchar({ length: 64 }).default("dashboard").notNull(),
    note: text(),
    date_created: timestamp({ withTimezone: true, mode: "string" }).default(sql`CURRENT_TIMESTAMP`),
    user_created: uuid(),
    color: varchar({ length: 255 }),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.user_created],
      foreignColumns: [directus_users.id],
      name: "directus_dashboards_user_created_foreign",
    }).onDelete("set null"),
  ],
);

export const directus_activity = pgTable("directus_activity", {
  id: serial().primaryKey().notNull(),
  action: varchar({ length: 45 }).notNull(),
  user: uuid(),
  timestamp: timestamp({ withTimezone: true, mode: "string" })
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
  ip: varchar({ length: 50 }),
  user_agent: text(),
  collection: varchar({ length: 64 }).notNull(),
  item: varchar({ length: 255 }).notNull(),
  origin: varchar({ length: 255 }),
});

export const directus_extensions = pgTable("directus_extensions", {
  enabled: boolean().default(true).notNull(),
  id: uuid().primaryKey().notNull(),
  folder: varchar({ length: 255 }).notNull(),
  source: varchar({ length: 255 }).notNull(),
  bundle: uuid(),
});

export const directus_access = pgTable(
  "directus_access",
  {
    id: uuid().primaryKey().notNull(),
    role: uuid(),
    user: uuid(),
    policy: uuid().notNull(),
    sort: integer(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.policy],
      foreignColumns: [directus_policies.id],
      name: "directus_access_policy_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.role],
      foreignColumns: [directus_roles.id],
      name: "directus_access_role_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.user],
      foreignColumns: [directus_users.id],
      name: "directus_access_user_foreign",
    }).onDelete("cascade"),
  ],
);

export const directus_collections = pgTable(
  "directus_collections",
  {
    collection: varchar({ length: 64 }).primaryKey().notNull(),
    icon: varchar({ length: 64 }),
    note: text(),
    display_template: varchar({ length: 255 }),
    hidden: boolean().default(false).notNull(),
    singleton: boolean().default(false).notNull(),
    translations: json(),
    archive_field: varchar({ length: 64 }),
    archive_app_filter: boolean().default(true).notNull(),
    archive_value: varchar({ length: 255 }),
    unarchive_value: varchar({ length: 255 }),
    sort_field: varchar({ length: 64 }),
    accountability: varchar({ length: 255 }).default("all"),
    color: varchar({ length: 255 }),
    item_duplication_fields: json(),
    sort: integer(),
    group: varchar({ length: 64 }),
    collapse: varchar({ length: 255 }).default("open").notNull(),
    preview_url: varchar({ length: 255 }),
    versioning: boolean().default(false).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.group],
      foreignColumns: [table.collection],
      name: "directus_collections_group_foreign",
    }),
  ],
);

export const directus_fields = pgTable("directus_fields", {
  id: serial().primaryKey().notNull(),
  collection: varchar({ length: 64 }).notNull(),
  field: varchar({ length: 64 }).notNull(),
  special: varchar({ length: 64 }),
  interface: varchar({ length: 64 }),
  options: json(),
  display: varchar({ length: 64 }),
  display_options: json(),
  readonly: boolean().default(false).notNull(),
  hidden: boolean().default(false).notNull(),
  sort: integer(),
  width: varchar({ length: 30 }).default("full"),
  translations: json(),
  note: text(),
  conditions: json(),
  required: boolean().default(false),
  group: varchar({ length: 64 }),
  validation: json(),
  validation_message: text(),
  searchable: boolean().default(true).notNull(),
});

export const directus_notifications = pgTable(
  "directus_notifications",
  {
    id: serial().primaryKey().notNull(),
    timestamp: timestamp({ withTimezone: true, mode: "string" }).default(sql`CURRENT_TIMESTAMP`),
    status: varchar({ length: 255 }).default("inbox"),
    recipient: uuid().notNull(),
    sender: uuid(),
    subject: varchar({ length: 255 }).notNull(),
    message: text(),
    collection: varchar({ length: 64 }),
    item: varchar({ length: 255 }),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.recipient],
      foreignColumns: [directus_users.id],
      name: "directus_notifications_recipient_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.sender],
      foreignColumns: [directus_users.id],
      name: "directus_notifications_sender_foreign",
    }),
  ],
);

export const directus_migrations = pgTable("directus_migrations", {
  version: varchar({ length: 255 }).primaryKey().notNull(),
  name: varchar({ length: 255 }).notNull(),
  timestamp: timestamp({ withTimezone: true, mode: "string" }).default(sql`CURRENT_TIMESTAMP`),
});

export const directus_operations = pgTable(
  "directus_operations",
  {
    id: uuid().primaryKey().notNull(),
    name: varchar({ length: 255 }),
    key: varchar({ length: 255 }).notNull(),
    type: varchar({ length: 255 }).notNull(),
    position_x: integer().notNull(),
    position_y: integer().notNull(),
    options: json(),
    resolve: uuid(),
    reject: uuid(),
    flow: uuid().notNull(),
    date_created: timestamp({ withTimezone: true, mode: "string" }).default(sql`CURRENT_TIMESTAMP`),
    user_created: uuid(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.flow],
      foreignColumns: [directus_flows.id],
      name: "directus_operations_flow_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.reject],
      foreignColumns: [table.id],
      name: "directus_operations_reject_foreign",
    }),
    foreignKey({
      columns: [table.resolve],
      foreignColumns: [table.id],
      name: "directus_operations_resolve_foreign",
    }),
    foreignKey({
      columns: [table.user_created],
      foreignColumns: [directus_users.id],
      name: "directus_operations_user_created_foreign",
    }).onDelete("set null"),
    unique("directus_operations_resolve_unique").on(table.resolve),
    unique("directus_operations_reject_unique").on(table.reject),
  ],
);

export const directus_folders = pgTable(
  "directus_folders",
  {
    id: uuid().primaryKey().notNull(),
    name: varchar({ length: 255 }).notNull(),
    parent: uuid(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.parent],
      foreignColumns: [table.id],
      name: "directus_folders_parent_foreign",
    }),
  ],
);

export const directus_flows = pgTable(
  "directus_flows",
  {
    id: uuid().primaryKey().notNull(),
    name: varchar({ length: 255 }).notNull(),
    icon: varchar({ length: 64 }),
    color: varchar({ length: 255 }),
    description: text(),
    status: varchar({ length: 255 }).default("active").notNull(),
    trigger: varchar({ length: 255 }),
    accountability: varchar({ length: 255 }).default("all"),
    options: json(),
    operation: uuid(),
    date_created: timestamp({ withTimezone: true, mode: "string" }).default(sql`CURRENT_TIMESTAMP`),
    user_created: uuid(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.user_created],
      foreignColumns: [directus_users.id],
      name: "directus_flows_user_created_foreign",
    }).onDelete("set null"),
    unique("directus_flows_operation_unique").on(table.operation),
  ],
);

export const directus_presets = pgTable(
  "directus_presets",
  {
    id: serial().primaryKey().notNull(),
    bookmark: varchar({ length: 255 }),
    user: uuid(),
    role: uuid(),
    collection: varchar({ length: 64 }),
    search: varchar({ length: 100 }),
    layout: varchar({ length: 100 }).default("tabular"),
    layout_query: json(),
    layout_options: json(),
    refresh_interval: integer(),
    filter: json(),
    icon: varchar({ length: 64 }).default("bookmark"),
    color: varchar({ length: 255 }),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.role],
      foreignColumns: [directus_roles.id],
      name: "directus_presets_role_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.user],
      foreignColumns: [directus_users.id],
      name: "directus_presets_user_foreign",
    }).onDelete("cascade"),
  ],
);

export const directus_roles = pgTable(
  "directus_roles",
  {
    id: uuid().primaryKey().notNull(),
    name: varchar({ length: 100 }).notNull(),
    icon: varchar({ length: 64 }).default("supervised_user_circle").notNull(),
    description: text(),
    parent: uuid(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.parent],
      foreignColumns: [table.id],
      name: "directus_roles_parent_foreign",
    }),
  ],
);

export const directus_revisions = pgTable(
  "directus_revisions",
  {
    id: serial().primaryKey().notNull(),
    activity: integer().notNull(),
    collection: varchar({ length: 64 }).notNull(),
    item: varchar({ length: 255 }).notNull(),
    data: json(),
    delta: json(),
    parent: integer(),
    version: uuid(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.activity],
      foreignColumns: [directus_activity.id],
      name: "directus_revisions_activity_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.parent],
      foreignColumns: [table.id],
      name: "directus_revisions_parent_foreign",
    }),
    foreignKey({
      columns: [table.version],
      foreignColumns: [directus_versions.id],
      name: "directus_revisions_version_foreign",
    }).onDelete("cascade"),
  ],
);

export const directus_relations = pgTable("directus_relations", {
  id: serial().primaryKey().notNull(),
  many_collection: varchar({ length: 64 }).notNull(),
  many_field: varchar({ length: 64 }).notNull(),
  one_collection: varchar({ length: 64 }),
  one_field: varchar({ length: 64 }),
  one_collection_field: varchar({ length: 64 }),
  one_allowed_collections: text(),
  junction_field: varchar({ length: 64 }),
  sort_field: varchar({ length: 64 }),
  one_deselect_action: varchar({ length: 255 }).default("nullify").notNull(),
});

export const directus_shares = pgTable(
  "directus_shares",
  {
    id: uuid().primaryKey().notNull(),
    name: varchar({ length: 255 }),
    collection: varchar({ length: 64 }).notNull(),
    item: varchar({ length: 255 }).notNull(),
    role: uuid(),
    password: varchar({ length: 255 }),
    user_created: uuid(),
    date_created: timestamp({ withTimezone: true, mode: "string" }).default(sql`CURRENT_TIMESTAMP`),
    date_start: timestamp({ withTimezone: true, mode: "string" }),
    date_end: timestamp({ withTimezone: true, mode: "string" }),
    times_used: integer().default(0),
    max_uses: integer(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.collection],
      foreignColumns: [directus_collections.collection],
      name: "directus_shares_collection_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.role],
      foreignColumns: [directus_roles.id],
      name: "directus_shares_role_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.user_created],
      foreignColumns: [directus_users.id],
      name: "directus_shares_user_created_foreign",
    }).onDelete("set null"),
  ],
);

export const directus_panels = pgTable(
  "directus_panels",
  {
    id: uuid().primaryKey().notNull(),
    dashboard: uuid().notNull(),
    name: varchar({ length: 255 }),
    icon: varchar({ length: 64 }).default(sql`NULL`),
    color: varchar({ length: 10 }),
    show_header: boolean().default(false).notNull(),
    note: text(),
    type: varchar({ length: 255 }).notNull(),
    position_x: integer().notNull(),
    position_y: integer().notNull(),
    width: integer().notNull(),
    height: integer().notNull(),
    options: json(),
    date_created: timestamp({ withTimezone: true, mode: "string" }).default(sql`CURRENT_TIMESTAMP`),
    user_created: uuid(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.dashboard],
      foreignColumns: [directus_dashboards.id],
      name: "directus_panels_dashboard_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.user_created],
      foreignColumns: [directus_users.id],
      name: "directus_panels_user_created_foreign",
    }).onDelete("set null"),
  ],
);

export const directus_settings = pgTable(
  "directus_settings",
  {
    id: serial().primaryKey().notNull(),
    project_name: varchar({ length: 100 }).default("Directus").notNull(),
    project_url: varchar({ length: 255 }),
    project_color: varchar({ length: 255 }).default("#6644FF").notNull(),
    project_logo: uuid(),
    public_foreground: uuid(),
    public_background: uuid(),
    public_note: text(),
    auth_login_attempts: integer().default(25),
    auth_password_policy: varchar({ length: 100 }),
    storage_asset_transform: varchar({ length: 7 }).default("all"),
    storage_asset_presets: json(),
    custom_css: text(),
    storage_default_folder: uuid(),
    basemaps: json(),
    mapbox_key: varchar({ length: 255 }),
    module_bar: json(),
    project_descriptor: varchar({ length: 100 }),
    default_language: varchar({ length: 255 }).default("en-US").notNull(),
    custom_aspect_ratios: json(),
    public_favicon: uuid(),
    default_appearance: varchar({ length: 255 }).default("auto").notNull(),
    default_theme_light: varchar({ length: 255 }),
    theme_light_overrides: json(),
    default_theme_dark: varchar({ length: 255 }),
    theme_dark_overrides: json(),
    report_error_url: varchar({ length: 255 }),
    report_bug_url: varchar({ length: 255 }),
    report_feature_url: varchar({ length: 255 }),
    public_registration: boolean().default(false).notNull(),
    public_registration_verify_email: boolean().default(true).notNull(),
    public_registration_role: uuid(),
    public_registration_email_filter: json(),
    visual_editor_urls: json(),
    project_id: uuid(),
    mcp_enabled: boolean().default(false).notNull(),
    mcp_allow_deletes: boolean().default(false).notNull(),
    mcp_prompts_collection: varchar({ length: 255 }).default(sql`NULL`),
    mcp_system_prompt_enabled: boolean().default(true).notNull(),
    mcp_system_prompt: text(),
    project_owner: varchar({ length: 255 }),
    project_usage: varchar({ length: 255 }),
    org_name: varchar({ length: 255 }),
    product_updates: boolean(),
    project_status: varchar({ length: 255 }),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.project_logo],
      foreignColumns: [directus_files.id],
      name: "directus_settings_project_logo_foreign",
    }),
    foreignKey({
      columns: [table.public_background],
      foreignColumns: [directus_files.id],
      name: "directus_settings_public_background_foreign",
    }),
    foreignKey({
      columns: [table.public_favicon],
      foreignColumns: [directus_files.id],
      name: "directus_settings_public_favicon_foreign",
    }),
    foreignKey({
      columns: [table.public_foreground],
      foreignColumns: [directus_files.id],
      name: "directus_settings_public_foreground_foreign",
    }),
    foreignKey({
      columns: [table.public_registration_role],
      foreignColumns: [directus_roles.id],
      name: "directus_settings_public_registration_role_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.storage_default_folder],
      foreignColumns: [directus_folders.id],
      name: "directus_settings_storage_default_folder_foreign",
    }).onDelete("set null"),
  ],
);

export const directus_sync_id_map = pgTable(
  "directus_sync_id_map",
  {
    id: serial().primaryKey().notNull(),
    table: varchar({ length: 255 }).notNull(),
    sync_id: varchar({ length: 255 }).notNull(),
    local_id: varchar({ length: 255 }).notNull(),
    created_at: timestamp({ withTimezone: true, mode: "string" }).default(sql`CURRENT_TIMESTAMP`),
  },
  (table): PgTableExtraConfigValue[] => [
    index().using("btree", table.created_at.asc().nullsLast()),
    unique("directus_sync_id_map_table_local_id_unique").on(table.table, table.local_id),
    unique("directus_sync_id_map_table_sync_id_unique").on(table.table, table.sync_id),
  ],
);

export const directus_translations = pgTable("directus_translations", {
  id: uuid().primaryKey().notNull(),
  language: varchar({ length: 255 }).notNull(),
  key: varchar({ length: 255 }).notNull(),
  value: text().notNull(),
});

export const directus_policies = pgTable("directus_policies", {
  id: uuid().primaryKey().notNull(),
  name: varchar({ length: 100 }).notNull(),
  icon: varchar({ length: 64 }).default("badge").notNull(),
  description: text(),
  ip_access: text(),
  enforce_tfa: boolean().default(false).notNull(),
  admin_access: boolean().default(false).notNull(),
  app_access: boolean().default(false).notNull(),
});

export const directus_users = pgTable(
  "directus_users",
  {
    id: uuid().primaryKey().notNull(),
    first_name: varchar({ length: 50 }),
    last_name: varchar({ length: 50 }),
    email: varchar({ length: 128 }),
    password: varchar({ length: 255 }),
    location: varchar({ length: 255 }),
    title: varchar({ length: 50 }),
    description: text(),
    tags: json(),
    avatar: uuid(),
    language: varchar({ length: 255 }).default(sql`NULL`),
    tfa_secret: varchar({ length: 255 }),
    status: varchar({ length: 16 }).default("active").notNull(),
    role: uuid(),
    token: varchar({ length: 255 }),
    last_access: timestamp({ withTimezone: true, mode: "string" }),
    last_page: varchar({ length: 255 }),
    provider: varchar({ length: 128 }).default("default").notNull(),
    external_identifier: varchar({ length: 255 }),
    auth_data: json(),
    email_notifications: boolean().default(true),
    appearance: varchar({ length: 255 }),
    theme_dark: varchar({ length: 255 }),
    theme_light: varchar({ length: 255 }),
    theme_light_overrides: json(),
    theme_dark_overrides: json(),
    text_direction: varchar({ length: 255 }).default("auto").notNull(),
    disable_create_project: boolean().default(false),
    hide_ai_suggestions: boolean().default(false),
    legal_basis: varchar({ length: 255 }).default("client-managed"),
    privacy_policy_url: varchar({ length: 255 }).default(sql`NULL`),
    quick_access_preferences: json().default([]),
    whitelabel_logo: uuid(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.role],
      foreignColumns: [directus_roles.id],
      name: "directus_users_role_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.whitelabel_logo],
      foreignColumns: [directus_files.id],
      name: "directus_users_whitelabel_logo_foreign",
    }).onDelete("set null"),
    unique("directus_users_email_unique").on(table.email),
    unique("directus_users_token_unique").on(table.token),
    unique("directus_users_external_identifier_unique").on(table.external_identifier),
  ],
);

export const directus_permissions = pgTable(
  "directus_permissions",
  {
    id: serial().primaryKey().notNull(),
    collection: varchar({ length: 64 }).notNull(),
    action: varchar({ length: 10 }).notNull(),
    permissions: json(),
    validation: json(),
    presets: json(),
    fields: text(),
    policy: uuid().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.policy],
      foreignColumns: [directus_policies.id],
      name: "directus_permissions_policy_foreign",
    }).onDelete("cascade"),
  ],
);

export const map_embedding = pgTable(
  "map_embedding",
  {
    config_key: varchar({ length: 64 }).default(sql`NULL`).notNull(),
    created_at: timestamp({ withTimezone: true, mode: "string" }),
    dims: integer().notNull(),
    id: uuid().primaryKey().notNull(),
    input_hash: varchar({ length: 64 }).default(sql`NULL`).notNull(),
    model: varchar({ length: 255 }).default(sql`NULL`).notNull(),
    project_id: uuid().notNull(),
    embedding: vector("embedding").notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("map_embedding_project_input_config").using(
      "btree",
      table.project_id.asc().nullsLast(),
      table.input_hash.asc().nullsLast(),
      table.config_key.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.project_id],
      foreignColumns: [project.id],
      name: "map_embedding_project_id_foreign",
    }).onDelete("cascade"),
    check("map_embedding_dims_match", sql`(dims > 0) AND (vector_dims(embedding) = dims)`),
    check("map_embedding_nonzero", sql`vector_norm(embedding) > (0)::double precision`),
  ],
);

export const org = pgTable(
  "org",
  {
    created_at: timestamp({ withTimezone: true, mode: "string" }).default(sql`CURRENT_TIMESTAMP`),
    created_by: uuid(),
    deleted_at: timestamp({ withTimezone: true, mode: "string" }),
    id: uuid().primaryKey().notNull(),
    logo_url: varchar({ length: 255 }).default(sql`NULL`),
    name: varchar({ length: 255 }).default(sql`NULL`).notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" }).default(sql`CURRENT_TIMESTAMP`),
    description: text(),
    is_partner: boolean().default(false).notNull(),
    agent_access_enabled: boolean().default(false).notNull(),
    agent_access_updated_at: timestamp({ withTimezone: true, mode: "string" }),
    agent_access_updated_by: uuid(),
    // Customer accounts: null for organisations dembrane does not manage as an account.
    account_stage: varchar({ length: 32 }),
    origin_pricing_configuration_id: uuid(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.created_by],
      foreignColumns: [app_user.id],
      name: "org_created_by_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.origin_pricing_configuration_id],
      foreignColumns: [pricing_configuration.id],
      name: "org_origin_pricing_configuration_id_foreign",
    }).onDelete("set null"),
    check(
      "org_account_stage_check",
      sql`${table.account_stage} is null or ${table.account_stage} in ('prospect', 'customer', 'churned')`,
    ),
  ],
);

export const map_fact_check = pgTable(
  "map_fact_check",
  {
    attempt: integer().default(0).notNull(),
    claim_key: varchar({ length: 64 }).default(sql`NULL`).notNull(),
    completed_at: timestamp({ withTimezone: true, mode: "string" }),
    created_at: timestamp({ withTimezone: true, mode: "string" }),
    error: text(),
    id: uuid().primaryKey().notNull(),
    justification: text(),
    model: varchar({ length: 255 }).default(sql`NULL`),
    project_id: uuid().notNull(),
    prompt_version: varchar({ length: 128 }).default(sql`NULL`),
    requested_by: varchar({ length: 64 }).default(sql`NULL`),
    sources: json(),
    started_at: timestamp({ withTimezone: true, mode: "string" }),
    statement: text().notNull(),
    status: varchar({ length: 32 }).default(sql`NULL`).notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" }),
    verdict: varchar({ length: 32 }).default(sql`NULL`),
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("map_fact_check_project_claim").using(
      "btree",
      table.project_id.asc().nullsLast(),
      table.claim_key.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.project_id],
      foreignColumns: [project.id],
      name: "map_fact_check_project_id_foreign",
    }).onDelete("cascade"),
  ],
);

// A cluster a host held the cursor over on the Map, titled by the `map.group` run. One row
// per selection of a snapshot (selection_key); members are revision and object ids, most
// central first, so a group still finds its objects after a regeneration.
export const map_group = pgTable(
  "map_group",
  {
    id: uuid().primaryKey().notNull(),
    project_id: uuid().notNull(),
    snapshot_id: uuid().notNull(),
    selection_key: varchar({ length: 64 }).notNull(),
    members: json().notNull(),
    status: varchar({ length: 32 }).notNull(),
    attempt: integer().default(1).notNull(),
    title: text(),
    error: text(),
    model: varchar({ length: 255 }),
    prompt_version: varchar({ length: 128 }),
    requested_by: varchar({ length: 64 }),
    created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow().notNull(),
    completed_at: timestamp({ withTimezone: true, mode: "string" }),
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("map_group_project_selection").using(
      "btree",
      table.project_id.asc().nullsLast(),
      table.selection_key.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.project_id],
      foreignColumns: [project.id],
      name: "map_group_project_id_foreign",
    }).onDelete("cascade"),
  ],
);

export const methodology = pgTable(
  "methodology",
  {
    created_at: timestamp({ withTimezone: true, mode: "string" }),
    description: text(),
    framing: text(),
    id: uuid().primaryKey().notNull(),
    is_seeded: boolean().default(false),
    name: varchar({ length: 255 }).default(sql`NULL`).notNull(),
    owner_directus_user_id: varchar({ length: 255 }).default(sql`NULL`),
    updated_at: timestamp({ withTimezone: true, mode: "string" }),
    visibility: varchar({ length: 255 }).default("private"),
    workspace_id: uuid(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.workspace_id],
      foreignColumns: [workspace.id],
      name: "methodology_workspace_id_foreign",
    }).onDelete("set null"),
  ],
);

export const languages = pgTable("languages", {
  code: varchar({ length: 255 }).default(sql`NULL`).primaryKey().notNull(),
  direction: varchar({ length: 255 }).default("ltr"),
  name: varchar({ length: 255 }).default(sql`NULL`),
});

export const model_response_feedback = pgTable(
  "model_response_feedback",
  {
    chat_mode: varchar({ length: 255 }).default(sql`NULL`),
    comment: text(),
    context: json(),
    date_created: timestamp({ withTimezone: true, mode: "string" }),
    date_updated: timestamp({ withTimezone: true, mode: "string" }),
    id: uuid().primaryKey().notNull(),
    project_id: uuid(),
    rating: varchar({ length: 255 }).default(sql`NULL`).notNull(),
    reason: varchar({ length: 255 }).default(sql`NULL`),
    reasons: json(),
    response_snapshot: text(),
    target_id: varchar({ length: 255 }).default(sql`NULL`).notNull(),
    target_type: varchar({ length: 255 }).default(sql`NULL`).notNull(),
    user_id: uuid(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.project_id],
      foreignColumns: [project.id],
      name: "model_response_feedback_project_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.user_id],
      foreignColumns: [directus_users.id],
      name: "model_response_feedback_user_id_foreign",
    }).onDelete("set null"),
  ],
);

export const notification = pgTable(
  "notification",
  {
    action: varchar({ length: 255 }).default("NONE").notNull(),
    actor_user_id: uuid(),
    audience_user_id: uuid().notNull(),
    created_at: timestamp({ withTimezone: true, mode: "string" }).default(sql`CURRENT_TIMESTAMP`),
    event_code: varchar({ length: 255 }).default(sql`NULL`).notNull(),
    expires_at: timestamp({ withTimezone: true, mode: "string" }),
    id: uuid().primaryKey().notNull(),
    message: text(),
    params: json(),
    read_at: timestamp({ withTimezone: true, mode: "string" }),
    ref_chat_id: uuid(),
    ref_conversation_id: uuid(),
    ref_invite_id: uuid(),
    ref_org_id: uuid(),
    ref_project_id: uuid(),
    ref_report_id: varchar({ length: 255 }).default(sql`NULL`),
    ref_workspace_id: uuid(),
    scope: varchar({ length: 255 }).default(sql`NULL`),
    severity: varchar({ length: 255 }).default("info").notNull(),
    title: varchar({ length: 255 }).default(sql`NULL`).notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" }).default(sql`CURRENT_TIMESTAMP`),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.actor_user_id],
      foreignColumns: [app_user.id],
      name: "notification_actor_user_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.audience_user_id],
      foreignColumns: [app_user.id],
      name: "notification_audience_user_id_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.ref_chat_id],
      foreignColumns: [project_chat.id],
      name: "notification_ref_chat_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.ref_conversation_id],
      foreignColumns: [conversation.id],
      name: "notification_ref_conversation_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.ref_invite_id],
      foreignColumns: [workspace_invite.id],
      name: "notification_ref_invite_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.ref_org_id],
      foreignColumns: [org.id],
      name: "notification_ref_org_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.ref_project_id],
      foreignColumns: [project.id],
      name: "notification_ref_project_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.ref_workspace_id],
      foreignColumns: [workspace.id],
      name: "notification_ref_workspace_id_foreign",
    }).onDelete("set null"),
  ],
);

export const org_invite = pgTable(
  "org_invite",
  {
    accepted_at: timestamp({ withTimezone: true, mode: "string" }),
    created_at: timestamp({ withTimezone: true, mode: "string" }).default(sql`CURRENT_TIMESTAMP`),
    deleted_at: timestamp({ withTimezone: true, mode: "string" }),
    email: varchar({ length: 255 }).default(sql`NULL`).notNull(),
    expires_at: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    id: uuid().primaryKey().notNull(),
    invited_by: uuid(),
    org_id: uuid().notNull(),
    role: varchar({ length: 255 }).default("member").notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index().using("btree", table.accepted_at.asc().nullsLast()),
    index().using("btree", table.deleted_at.asc().nullsLast()),
    index().using("btree", table.email.asc().nullsLast()),
    foreignKey({
      columns: [table.invited_by],
      foreignColumns: [app_user.id],
      name: "org_invite_invited_by_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.org_id],
      foreignColumns: [org.id],
      name: "org_invite_org_id_foreign",
    }).onDelete("cascade"),
  ],
);

export const org_membership = pgTable(
  "org_membership",
  {
    created_at: timestamp({ withTimezone: true, mode: "string" }).default(sql`CURRENT_TIMESTAMP`),
    custom_policies: json().default([]),
    deleted_at: timestamp({ withTimezone: true, mode: "string" }),
    id: uuid().primaryKey().notNull(),
    org_id: uuid().notNull(),
    role: varchar({ length: 255 }).default(sql`NULL`).notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" }).default(sql`CURRENT_TIMESTAMP`),
    user_id: uuid().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    // Who belongs where, read on every dashboard load (the accounts tasks summary).
    index("org_membership_user_id_index").using("btree", table.user_id.asc().nullsLast()),
    foreignKey({
      columns: [table.org_id],
      foreignColumns: [org.id],
      name: "org_membership_org_id_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.user_id],
      foreignColumns: [app_user.id],
      name: "org_membership_user_id_foreign",
    }).onDelete("cascade"),
  ],
);

export const directus_versions = pgTable(
  "directus_versions",
  {
    id: uuid().primaryKey().notNull(),
    key: varchar({ length: 64 }).notNull(),
    name: varchar({ length: 255 }),
    collection: varchar({ length: 64 }).notNull(),
    item: varchar({ length: 255 }).notNull(),
    hash: varchar({ length: 255 }),
    date_created: timestamp({ withTimezone: true, mode: "string" }).default(sql`CURRENT_TIMESTAMP`),
    date_updated: timestamp({ withTimezone: true, mode: "string" }).default(sql`CURRENT_TIMESTAMP`),
    user_created: uuid(),
    user_updated: uuid(),
    delta: json(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.collection],
      foreignColumns: [directus_collections.collection],
      name: "directus_versions_collection_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.user_created],
      foreignColumns: [directus_users.id],
      name: "directus_versions_user_created_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.user_updated],
      foreignColumns: [directus_users.id],
      name: "directus_versions_user_updated_foreign",
    }),
  ],
);

export const map_result = pgTable(
  "map_result",
  {
    completed_at: timestamp({ withTimezone: true, mode: "string" }),
    created_at: timestamp({ withTimezone: true, mode: "string" }),
    embedding_config: json(),
    error: text(),
    execution_ref: varchar({ length: 128 }).default(sql`NULL`),
    id: uuid().primaryKey().notNull(),
    manifest: json(),
    manifest_version: integer().default(1).notNull(),
    progress: json(),
    project_id: uuid().notNull(),
    recipe_version: varchar({ length: 64 }).default(sql`NULL`).notNull(),
    requested_by: varchar({ length: 64 }).default(sql`NULL`),
    snapshot_id: uuid(),
    source_fingerprint: varchar({ length: 64 }).default(sql`NULL`),
    status: varchar({ length: 32 }).default(sql`NULL`).notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" }),
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("map_result_one_active_attempt")
      .using("btree", table.project_id.asc().nullsLast())
      .where(
        sql`((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('extracting'::character varying)::text, ('embedding'::character varying)::text]))`,
      ),
    index("map_result_project_status_created").using(
      "btree",
      table.project_id.asc().nullsLast(),
      table.status.asc().nullsLast(),
      table.created_at.desc().nullsFirst(),
    ),
    foreignKey({
      columns: [table.project_id],
      foreignColumns: [project.id],
      name: "map_result_project_id_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.snapshot_id],
      foreignColumns: [analysis_snapshot.id],
      name: "map_result_snapshot_id_foreign",
    }).onDelete("set null"),
    check("map_result_manifest_version_valid", sql`manifest_version = ANY (ARRAY[1, 2])`),
  ],
);

export const directus_webhooks = pgTable(
  "directus_webhooks",
  {
    id: serial().primaryKey().notNull(),
    name: varchar({ length: 255 }).notNull(),
    method: varchar({ length: 10 }).default("POST").notNull(),
    url: varchar({ length: 255 }).notNull(),
    status: varchar({ length: 10 }).default("active").notNull(),
    data: boolean().default(true).notNull(),
    actions: varchar({ length: 100 }).notNull(),
    collections: varchar({ length: 255 }).notNull(),
    headers: json(),
    was_active_before_deprecation: boolean().default(false).notNull(),
    migrated_flow: uuid(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.migrated_flow],
      foreignColumns: [directus_flows.id],
      name: "directus_webhooks_migrated_flow_foreign",
    }).onDelete("set null"),
  ],
);

export const pricing_configuration = pgTable(
  "pricing_configuration",
  {
    id: uuid().primaryKey().notNull(),
    reference: varchar({ length: 255 }).default(sql`NULL`),
    config_session_id: varchar({ length: 255 }).default(sql`NULL`).notNull(),
    status: varchar({ length: 255 }).default("in_progress"),
    email: varchar({ length: 255 }).default(sql`NULL`),
    user_id: varchar({ length: 255 }).default(sql`NULL`),
    is_internal: boolean().default(false).notNull(),
    locale: varchar({ length: 255 }).default(sql`NULL`),
    mount: varchar({ length: 255 }).default("app"),
    wall_key: varchar({ length: 255 }).default(sql`NULL`),
    workspace_id: varchar({ length: 255 }).default(sql`NULL`),
    org_id: varchar({ length: 255 }).default(sql`NULL`),
    project_id: varchar({ length: 255 }).default(sql`NULL`),
    question_set_version: varchar({ length: 255 }).default(sql`NULL`),
    config_shape_version: integer(),
    answers_raw: json(),
    config: json(),
    volume_bucket: varchar({ length: 255 }).default(sql`NULL`),
    concurrency_bucket: varchar({ length: 255 }).default(sql`NULL`),
    concurrency_exact: integer(),
    answered_count: integer(),
    furthest_step: integer(),
    voice_transcript: text(),
    voice_audio: json(),
    booking_status: varchar({ length: 255 }).default("none"),
    booking_uid: varchar({ length: 255 }).default(sql`NULL`),
    created_at: timestamp({ withTimezone: true, mode: "string" }),
    updated_at: timestamp({ withTimezone: true, mode: "string" }),
    booking_notified_at: timestamp({ withTimezone: true, mode: "string" }),
  },
  (table): PgTableExtraConfigValue[] => [
    unique("pricing_configuration_reference_unique").on(table.reference),
    unique("pricing_configuration_config_session_id_unique").on(table.config_session_id),
  ],
);

export const project_agentic_run = pgTable(
  "project_agentic_run",
  {
    agent_thread_id: varchar({ length: 255 }).default(sql`NULL`),
    completed_at: timestamp({ withTimezone: true, mode: "string" }),
    created_at: timestamp({ withTimezone: true, mode: "string" }),
    directus_user_id: varchar({ length: 255 }).default(sql`NULL`),
    id: uuid().primaryKey().notNull(),
    last_event_seq: integer().default(0),
    latest_error: text(),
    latest_error_code: varchar({ length: 255 }).default(sql`NULL`),
    latest_output: text(),
    project_chat_id: uuid(),
    project_id: uuid(),
    started_at: timestamp({ withTimezone: true, mode: "string" }),
    status: varchar({ length: 255 }).default("queued"),
    updated_at: timestamp({ withTimezone: true, mode: "string" }),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.project_chat_id],
      foreignColumns: [project_chat.id],
      name: "project_agentic_run_project_chat_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.project_id],
      foreignColumns: [project.id],
      name: "project_agentic_run_project_id_foreign",
    }).onDelete("cascade"),
  ],
);

export const project_report = pgTable(
  "project_report",
  {
    content: text(),
    date_created: timestamp({ withTimezone: true, mode: "string" }),
    date_updated: timestamp({ withTimezone: true, mode: "string" }),
    deleted_at: timestamp({ withTimezone: true, mode: "string" }),
    error_code: varchar({ length: 255 }).default(sql`NULL`),
    error_message: text(),
    id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
    language: varchar({ length: 255 }).default(sql`NULL`),
    project_id: uuid(),
    scheduled_at: timestamp({ withTimezone: true, mode: "string" }),
    show_portal_link: boolean().default(false),
    status: varchar({ length: 255 }).default("published").notNull(),
    user_instructions: text(),
    user_created: uuid(),
    kind: varchar({ length: 255 }).default("report").notNull(),
    public_token: varchar({ length: 255 }).default(sql`NULL`),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.project_id],
      foreignColumns: [project.id],
      name: "project_report_project_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.user_created],
      foreignColumns: [directus_users.id],
      name: "project_report_user_created_foreign",
    }).onDelete("set null"),
  ],
);

export const project_chat_conversation = pgTable(
  "project_chat_conversation",
  {
    conversation_id: uuid(),
    id: serial().primaryKey().notNull(),
    project_chat_id: uuid(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.conversation_id],
      foreignColumns: [conversation.id],
      name: "project_chat_conversation_conversation_id_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.project_chat_id],
      foreignColumns: [project_chat.id],
      name: "project_chat_conversation_project_chat_id_foreign",
    }).onDelete("cascade"),
  ],
);

export const project_chat_message_conversation_1 = pgTable(
  "project_chat_message_conversation_1",
  {
    conversation_id: uuid(),
    id: serial().primaryKey().notNull(),
    project_chat_message_id: uuid(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.conversation_id],
      foreignColumns: [conversation.id],
      name: "project_chat_message_conversation_1_conversation_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.project_chat_message_id],
      foreignColumns: [project_chat_message.id],
      name: "project_chat_message_conversation_1_projec__225db2e8_foreign",
    }).onDelete("set null"),
  ],
);

export const processing_status = pgTable(
  "processing_status",
  {
    conversation_chunk_id: uuid(),
    conversation_id: uuid(),
    duration_ms: integer(),
    event: varchar({ length: 255 }).default(sql`NULL`),
    id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
    message: text(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    parent: bigint({ mode: "number" }),
    project_id: uuid(),
    timestamp: timestamp({ withTimezone: true, mode: "string" }),
  },
  (table): PgTableExtraConfigValue[] => [
    index().using("btree", table.conversation_chunk_id.asc().nullsLast()),
    // Serves lookups by conversation and the newest-first status reads; replaces the
    // single-column conversation_id index, which it covers.
    index("idx_processing_status_conversation_id_id").using(
      "btree",
      table.conversation_id.asc().nullsLast(),
      table.id.asc().nullsLast(),
    ),
    index().using("btree", table.parent.asc().nullsLast()),
    index().using("btree", table.project_id.asc().nullsLast()),
    foreignKey({
      columns: [table.conversation_chunk_id],
      foreignColumns: [conversation_chunk.id],
      name: "processing_status_conversation_chunk_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.conversation_id],
      foreignColumns: [conversation.id],
      name: "processing_status_conversation_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.parent],
      foreignColumns: [table.id],
      name: "processing_status_parent_foreign",
    }),
    foreignKey({
      columns: [table.project_id],
      foreignColumns: [project.id],
      name: "processing_status_project_id_foreign",
    }).onDelete("set null"),
  ],
);

export const project_chat_message_conversation = pgTable(
  "project_chat_message_conversation",
  {
    conversation_id: uuid(),
    id: serial().primaryKey().notNull(),
    project_chat_message_id: uuid(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.conversation_id],
      foreignColumns: [conversation.id],
      name: "project_chat_message_conversation_conversation_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.project_chat_message_id],
      foreignColumns: [project_chat_message.id],
      name: "project_chat_message_conversation_project___3af13f9a_foreign",
    }).onDelete("set null"),
  ],
);

export const project_membership = pgTable(
  "project_membership",
  {
    created_at: timestamp({ withTimezone: true, mode: "string" }).default(sql`CURRENT_TIMESTAMP`),
    custom_policies: json().default([]),
    granted_by: uuid(),
    id: uuid().primaryKey().notNull(),
    project_id: uuid().notNull(),
    user_id: uuid().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.granted_by],
      foreignColumns: [app_user.id],
      name: "project_membership_granted_by_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.project_id],
      foreignColumns: [project.id],
      name: "project_membership_project_id_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.user_id],
      foreignColumns: [app_user.id],
      name: "project_membership_user_id_foreign",
    }).onDelete("cascade"),
  ],
);

export const project_report_metric = pgTable(
  "project_report_metric",
  {
    date_created: timestamp({ withTimezone: true, mode: "string" }),
    date_updated: timestamp({ withTimezone: true, mode: "string" }),
    id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
    ip: varchar({ length: 255 }).default(sql`NULL`),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    project_report_id: bigint({ mode: "number" }),
    type: varchar({ length: 255 }).default(sql`NULL`),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.project_report_id],
      foreignColumns: [project_report.id],
      name: "project_report_metric_project_report_id_foreign",
    }).onDelete("set null"),
  ],
);

export const project = pgTable(
  "project",
  {
    anonymize_transcripts: boolean().default(false),
    context: text(),
    conversation_ask_for_participant_name_label: varchar({ length: 255 }).default(sql`NULL`),
    conversation_title_prompt: text(),
    created_at: timestamp({ withTimezone: true, mode: "string" }).default(sql`CURRENT_TIMESTAMP`),
    default_conversation_ask_for_participant_email: boolean().default(false),
    default_conversation_ask_for_participant_name: boolean().default(true),
    default_conversation_description: text(),
    default_conversation_finish_text: text(),
    default_conversation_title: varchar({ length: 255 }).default(sql`NULL`),
    default_conversation_transcript_prompt: text(),
    default_conversation_tutorial_slug: varchar({ length: 255 }).default("none"),
    deleted_at: timestamp({ withTimezone: true, mode: "string" }),
    directus_user_id: uuid(),
    enable_ai_title_and_tags: boolean().default(false),
    get_reply_mode: varchar({ length: 255 }).default("summarize"),
    get_reply_prompt: text(),
    id: uuid().primaryKey().notNull(),
    image_generation_model: varchar({ length: 255 }).default("PLACEHOLDER"),
    is_conversation_allowed: boolean().notNull(),
    is_enhanced_audio_processing_enabled: boolean().default(false),
    is_get_reply_enabled: boolean().default(false),
    is_project_notification_subscription_allowed: boolean().default(false),
    is_verify_enabled: boolean().default(false),
    is_verify_on_finish_enabled: boolean().default(false),
    language: varchar({ length: 255 }).default(sql`NULL`),
    name: varchar({ length: 255 }).default(sql`NULL`),
    pin_order: integer(),
    selected_verification_key_list: text(),
    updated_at: timestamp({ withTimezone: true, mode: "string" }).default(sql`CURRENT_TIMESTAMP`),
    visibility: varchar({ length: 255 }).default("workspace").notNull(),
    workspace_id: uuid(),
    host_guide: json(),
    move_history: json(),
    methodology_version_id: uuid(),
    is_canvas_enabled: boolean().default(false),
    legal_basis: varchar({ length: 255 }).default(sql`NULL`),
    privacy_policy_url: varchar({ length: 255 }).default(sql`NULL`),
    is_dembrane_event_cta_enabled: boolean().default(true),
    /**
     * A sample copy dembrane seeds (packages/samples): invented conversations no one
     * recorded. Usage, limits and public numbers leave it out, and it takes no new
     * conversations.
     */
    is_sample: boolean().default(false).notNull(),
    /** The fixture a sample copy was last seeded from, so a newer fixture updates it once. */
    sample_version: varchar({ length: 64 }),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.directus_user_id],
      foreignColumns: [directus_users.id],
      name: "project_directus_user_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.methodology_version_id],
      foreignColumns: [methodology_version.id],
      name: "project_methodology_version_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.workspace_id],
      foreignColumns: [workspace.id],
      name: "project_workspace_id_foreign",
    }).onDelete("set null"),
  ],
);

export const project_chat = pgTable(
  "project_chat",
  {
    auto_select: boolean().default(true),
    chat_mode: varchar({ length: 255 }).default(sql`NULL`),
    date_created: timestamp({ withTimezone: true, mode: "string" }),
    date_updated: timestamp({ withTimezone: true, mode: "string" }),
    deleted_at: timestamp({ withTimezone: true, mode: "string" }),
    id: uuid().primaryKey().notNull(),
    name: varchar({ length: 255 }).default(sql`NULL`),
    project_id: uuid(),
    user_created: uuid(),
    user_updated: uuid(),
    is_private: boolean().default(false),
  },
  (table): PgTableExtraConfigValue[] => [
    index().using("btree", table.project_id.asc().nullsLast()),
    foreignKey({
      columns: [table.project_id],
      foreignColumns: [project.id],
      name: "project_chat_project_id_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.user_created],
      foreignColumns: [directus_users.id],
      name: "project_chat_user_created_foreign",
    }),
    foreignKey({
      columns: [table.user_updated],
      foreignColumns: [directus_users.id],
      name: "project_chat_user_updated_foreign",
    }),
  ],
);

export const project_chat_message = pgTable(
  "project_chat_message",
  {
    date_created: timestamp({ withTimezone: true, mode: "string" }),
    date_updated: timestamp({ withTimezone: true, mode: "string" }),
    id: uuid().primaryKey().notNull(),
    message_from: varchar({ length: 255 }).default(sql`NULL`),
    project_chat_id: uuid(),
    template_key: varchar({ length: 255 }).default(sql`NULL`),
    text: text(),
    tokens_count: integer(),
  },
  (table): PgTableExtraConfigValue[] => [
    index().using("btree", table.project_chat_id.asc().nullsLast()),
    foreignKey({
      columns: [table.project_chat_id],
      foreignColumns: [project_chat.id],
      name: "project_chat_message_project_chat_id_foreign",
    }).onDelete("cascade"),
  ],
);

export const project_goal_revision = pgTable(
  "project_goal_revision",
  {
    chat_id: varchar({ length: 255 }).default(sql`NULL`),
    content: text().notNull(),
    created_at: timestamp({ withTimezone: true, mode: "string" }),
    created_by: varchar({ length: 255 }).default(sql`NULL`),
    id: uuid().primaryKey().notNull(),
    project_id: uuid(),
    set_by: varchar({ length: 255 }).default(sql`NULL`).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.project_id],
      foreignColumns: [project.id],
      name: "project_goal_revision_project_id_foreign",
    }).onDelete("set null"),
  ],
);

export const prompt_template = pgTable(
  "prompt_template",
  {
    content: text(),
    date_created: timestamp({ withTimezone: true, mode: "string" }),
    date_updated: timestamp({ withTimezone: true, mode: "string" }),
    description: text(),
    icon: varchar({ length: 50 }).default(sql`NULL`),
    id: uuid().primaryKey().notNull(),
    is_anonymous: boolean(),
    is_public: boolean().default(false),
    language: varchar({ length: 255 }).default(sql`NULL`),
    sort: integer(),
    tags: text(),
    title: varchar({ length: 200 }).default(sql`NULL`).notNull(),
    user_created: uuid(),
    scope: varchar({ length: 255 }).default("user").notNull(),
    workspace_id: uuid(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.user_created],
      foreignColumns: [directus_users.id],
      name: "prompt_template_user_created_foreign",
    }),
    foreignKey({
      columns: [table.workspace_id],
      foreignColumns: [workspace.id],
      name: "prompt_template_workspace_id_foreign",
    }).onDelete("cascade"),
  ],
);

export const recording_overage = pgTable(
  "recording_overage",
  {
    billing_account_id: uuid(),
    cap: integer(),
    closed_notified_at: timestamp({ withTimezone: true, mode: "string" }),
    ended_at: timestamp({ withTimezone: true, mode: "string" }),
    excess: integer(),
    id: uuid().primaryKey().notNull(),
    opened_by_project_id: uuid(),
    opened_notified_at: timestamp({ withTimezone: true, mode: "string" }),
    peak: integer(),
    started_at: timestamp({ withTimezone: true, mode: "string" }).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.billing_account_id],
      foreignColumns: [billing_account.id],
      name: "recording_overage_billing_account_id_foreign",
    }).onDelete("set null"),
  ],
);

export const support_access_event = pgTable(
  "support_access_event",
  {
    actor_user_id: uuid(),
    created_at: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    event_code: varchar({ length: 255 }).default(sql`NULL`).notNull(),
    id: uuid().primaryKey().notNull(),
    params: json(),
    staff_user_id: uuid(),
    workspace_id: uuid().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index().using("btree", table.created_at.asc().nullsLast()),
    index().using("btree", table.event_code.asc().nullsLast()),
    foreignKey({
      columns: [table.actor_user_id],
      foreignColumns: [app_user.id],
      name: "support_access_event_actor_user_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.staff_user_id],
      foreignColumns: [app_user.id],
      name: "support_access_event_staff_user_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.workspace_id],
      foreignColumns: [workspace.id],
      name: "support_access_event_workspace_id_foreign",
    }).onDelete("set null"),
  ],
);

export const scheduled_task = pgTable(
  "scheduled_task",
  {
    attempts: integer().default(0),
    claimed_at: timestamp({ withTimezone: true, mode: "string" }),
    created_at: timestamp({ withTimezone: true, mode: "string" }),
    error: text(),
    id: uuid().primaryKey().notNull(),
    payload: json(),
    scheduled_at: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    status: varchar({ length: 255 }).default("scheduled").notNull(),
    task_type: varchar({ length: 255 }).default("revoke_staff_support").notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" }),
  },
  (table): PgTableExtraConfigValue[] => [
    index().using("btree", table.scheduled_at.asc().nullsLast()),
    index().using("btree", table.status.asc().nullsLast()),
  ],
);

export const support_access_request = pgTable(
  "support_access_request",
  {
    created_at: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    expires_at: timestamp({ withTimezone: true, mode: "string" }),
    id: uuid().primaryKey().notNull(),
    membership_id: uuid(),
    message: text(),
    requested_by: uuid().notNull(),
    resolved_at: timestamp({ withTimezone: true, mode: "string" }),
    resolved_by: uuid(),
    status: varchar({ length: 255 }).default("pending").notNull(),
    workspace_id: uuid().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index().using("btree", table.status.asc().nullsLast()),
    foreignKey({
      columns: [table.membership_id],
      foreignColumns: [workspace_membership.id],
      name: "support_access_request_membership_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.requested_by],
      foreignColumns: [app_user.id],
      name: "support_access_request_requested_by_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.resolved_by],
      foreignColumns: [app_user.id],
      name: "support_access_request_resolved_by_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.workspace_id],
      foreignColumns: [workspace.id],
      name: "support_access_request_workspace_id_foreign",
    }).onDelete("set null"),
  ],
);

export const training_license = pgTable(
  "training_license",
  {
    app_user_id: uuid(),
    completed_at: timestamp({ withTimezone: true, mode: "string" }),
    created_at: timestamp({ withTimezone: true, mode: "string" }),
    expires_at: timestamp({ withTimezone: true, mode: "string" }),
    granted_by: uuid(),
    id: uuid().primaryKey().notNull(),
    org_id: uuid(),
    status: varchar({ length: 255 }).default("active"),
    training_id: uuid(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.app_user_id],
      foreignColumns: [app_user.id],
      name: "training_license_app_user_id_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.granted_by],
      foreignColumns: [app_user.id],
      name: "training_license_granted_by_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.org_id],
      foreignColumns: [org.id],
      name: "training_license_org_id_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.training_id],
      foreignColumns: [training.id],
      name: "training_license_training_id_foreign",
    }).onDelete("set null"),
  ],
);

export const support_request = pgTable("support_request", {
  created_at: timestamp({ withTimezone: true, mode: "string" }),
  directus_user_id: varchar({ length: 255 }).default(sql`NULL`),
  id: uuid().primaryKey().notNull(),
  message: text(),
  page_context: text(),
  project_chat_id: varchar({ length: 255 }).default(sql`NULL`),
  project_id: varchar({ length: 255 }).default(sql`NULL`),
  status: varchar({ length: 255 }).default("new"),
  workspace_id: varchar({ length: 255 }).default(sql`NULL`),
  app_user_id: varchar({ length: 255 }).default(sql`NULL`),
  chat_id: varchar({ length: 255 }).default(sql`NULL`),
  message_id: varchar({ length: 255 }).default(sql`NULL`),
  forwarded_at: timestamp({ withTimezone: true, mode: "string" }),
  source: varchar({ length: 255 }).default(sql`NULL`),
});

export const verification_topic_translations = pgTable(
  "verification_topic_translations",
  {
    id: serial().primaryKey().notNull(),
    label: varchar({ length: 255 }).default(sql`NULL`),
    languages_code: varchar({ length: 255 }).default(sql`NULL`),
    verification_topic_key: varchar({ length: 255 }).default(sql`NULL`),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.languages_code],
      foreignColumns: [languages.code],
      name: "verification_topic_translations_languages_code_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.verification_topic_key],
      foreignColumns: [verification_topic.key],
      name: "verification_topic_translations_verificati__34868e89_foreign",
    }).onDelete("set null"),
  ],
);

export const usage_insight = pgTable("usage_insight", {
  created_at: timestamp({ withTimezone: true, mode: "string" }),
  directus_user_id: varchar({ length: 255 }).default(sql`NULL`),
  id: uuid().primaryKey().notNull(),
  insight_type: varchar({ length: 255 }).default("intent"),
  project_chat_id: varchar({ length: 255 }).default(sql`NULL`),
  project_id: varchar({ length: 255 }).default(sql`NULL`),
  status: varchar({ length: 255 }).default("new"),
  summary: text(),
  workspace_id: varchar({ length: 255 }).default(sql`NULL`),
  app_user_id: varchar({ length: 255 }).default(sql`NULL`),
  chat_id: varchar({ length: 255 }).default(sql`NULL`),
  message_id: varchar({ length: 255 }).default(sql`NULL`),
});

export const project_tag = pgTable(
  "project_tag",
  {
    created_at: timestamp({ withTimezone: true, mode: "string" }).default(sql`CURRENT_TIMESTAMP`),
    id: uuid().primaryKey().notNull(),
    project_id: uuid().notNull(),
    sort: integer(),
    text: varchar({ length: 255 }).default(sql`NULL`),
    updated_at: timestamp({ withTimezone: true, mode: "string" }).default(sql`CURRENT_TIMESTAMP`),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.project_id],
      foreignColumns: [project.id],
      name: "project_tag_project_id_foreign",
    }).onDelete("cascade"),
  ],
);

export const project_report_notification_participants = pgTable(
  "project_report_notification_participants",
  {
    conversation_id: uuid(),
    date_submitted: timestamp({ withTimezone: true, mode: "string" }),
    date_updated: timestamp({ withTimezone: true, mode: "string" }),
    email: varchar({ length: 255 }).default(sql`NULL`),
    email_opt_in: boolean().default(true),
    email_opt_out_token: uuid(),
    id: uuid().primaryKey().notNull(),
    project_id: varchar({ length: 255 }).default(sql`NULL`),
    sort: integer(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.conversation_id],
      foreignColumns: [conversation.id],
      name: "project_report_notification_participants_c__5f83ce3c_foreign",
    }).onDelete("set null"),
  ],
);

export const project_webhook = pgTable(
  "project_webhook",
  {
    date_created: timestamp({ withTimezone: true, mode: "string" }),
    date_updated: timestamp({ withTimezone: true, mode: "string" }),
    deleted_at: timestamp({ withTimezone: true, mode: "string" }),
    events: text(),
    id: uuid().primaryKey().notNull(),
    name: text(),
    project_id: uuid(),
    secret: varchar({ length: 255 }).default(sql`NULL`),
    status: varchar({ length: 255 }).default("published").notNull(),
    url: text(),
    user_created: uuid(),
    user_updated: uuid(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.project_id],
      foreignColumns: [project.id],
      name: "project_webhook_project_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.user_created],
      foreignColumns: [directus_users.id],
      name: "project_webhook_user_created_foreign",
    }),
    foreignKey({
      columns: [table.user_updated],
      foreignColumns: [directus_users.id],
      name: "project_webhook_user_updated_foreign",
    }),
  ],
);

export const referral_ledger = pgTable(
  "referral_ledger",
  {
    created_by_staff_id: uuid(),
    deleted_at: timestamp({ withTimezone: true, mode: "string" }),
    expires_at: timestamp({ withTimezone: true, mode: "string" }),
    id: serial().primaryKey().notNull(),
    notes: text(),
    partner_kickback_percent: integer().default(20).notNull(),
    partner_team_id: uuid().notNull(),
    starts_at: timestamp({ withTimezone: true, mode: "string" })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    workspace_id: uuid().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.created_by_staff_id],
      foreignColumns: [app_user.id],
      name: "referral_ledger_created_by_staff_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.partner_team_id],
      foreignColumns: [org.id],
      name: "referral_ledger_partner_team_id_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspace_id],
      foreignColumns: [workspace.id],
      name: "referral_ledger_workspace_id_foreign",
    }).onDelete("cascade"),
  ],
);

export const training = pgTable(
  "training",
  {
    base_price_eur: real(),
    created_at: timestamp({ withTimezone: true, mode: "string" }),
    extra_participants: integer().default(0),
    extra_price_eur: real(),
    grants_license: boolean().default(true).notNull(),
    id: uuid().primaryKey().notNull(),
    included_participants: integer().default(0),
    notes: text(),
    org_id: uuid(),
    requested_by: uuid(),
    scheduled_at: timestamp({ withTimezone: true, mode: "string" }),
    status: varchar({ length: 255 }).default("requested"),
    type: varchar({ length: 255 }).default("online"),
    updated_at: timestamp({ withTimezone: true, mode: "string" }),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.org_id],
      foreignColumns: [org.id],
      name: "training_org_id_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.requested_by],
      foreignColumns: [app_user.id],
      name: "training_requested_by_foreign",
    }).onDelete("set null"),
  ],
);

export const workspace_membership = pgTable(
  "workspace_membership",
  {
    created_at: timestamp({ withTimezone: true, mode: "string" }).default(sql`CURRENT_TIMESTAMP`),
    custom_policies: json().default([]),
    deleted_at: timestamp({ withTimezone: true, mode: "string" }),
    id: uuid().primaryKey().notNull(),
    role: varchar({ length: 255 }).default(sql`NULL`).notNull(),
    source: varchar({ length: 255 }).default("direct").notNull(),
    updated_at: timestamp({ withTimezone: true, mode: "string" }).default(sql`CURRENT_TIMESTAMP`),
    user_id: uuid().notNull(),
    workspace_id: uuid().notNull(),
    expires_at: timestamp({ withTimezone: true, mode: "string" }),
  },
  (table): PgTableExtraConfigValue[] => [
    index().using("btree", table.expires_at.asc().nullsLast()),
    foreignKey({
      columns: [table.user_id],
      foreignColumns: [app_user.id],
      name: "workspace_membership_user_id_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspace_id],
      foreignColumns: [workspace.id],
      name: "workspace_membership_workspace_id_foreign",
    }).onDelete("cascade"),
  ],
);

export const workspace_invite = pgTable(
  "workspace_invite",
  {
    accepted_at: timestamp({ withTimezone: true, mode: "string" }),
    created_at: timestamp({ withTimezone: true, mode: "string" }).default(sql`CURRENT_TIMESTAMP`),
    email: varchar({ length: 255 }).default(sql`NULL`).notNull(),
    expires_at: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    id: uuid().primaryKey().notNull(),
    invited_by: uuid(),
    role: varchar({ length: 255 }).default(sql`NULL`).notNull(),
    workspace_id: uuid().notNull(),
    deleted_at: timestamp({ withTimezone: true, mode: "string" }),
    project_id: uuid(),
  },
  (table): PgTableExtraConfigValue[] => [
    index().using("btree", table.deleted_at.asc().nullsLast()),
    foreignKey({
      columns: [table.invited_by],
      foreignColumns: [app_user.id],
      name: "workspace_invite_invited_by_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.project_id],
      foreignColumns: [project.id],
      name: "workspace_invite_project_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.workspace_id],
      foreignColumns: [workspace.id],
      name: "workspace_invite_workspace_id_foreign",
    }).onDelete("cascade"),
  ],
);

export const workspace = pgTable(
  "workspace",
  {
    billed_to_team_id: uuid(),
    billed_to_workspace_id: uuid(),
    created_at: timestamp({ withTimezone: true, mode: "string" }).default(sql`CURRENT_TIMESTAMP`),
    created_by: uuid(),
    deleted_at: timestamp({ withTimezone: true, mode: "string" }),
    description: text(),
    effective_client_team_id: uuid(),
    handoff_status: varchar({ length: 255 }).default(sql`NULL`),
    handoff_target_team_id: uuid(),
    id: uuid().primaryKey().notNull(),
    is_default: boolean().default(false).notNull(),
    legal_basis: varchar({ length: 255 }).default(sql`NULL`),
    logo_url: varchar({ length: 255 }).default(sql`NULL`),
    name: varchar({ length: 255 }).default(sql`NULL`).notNull(),
    org_id: uuid().notNull(),
    privacy_policy_url: varchar({ length: 255 }).default(sql`NULL`),
    settings: json().default({}),
    updated_at: timestamp({ withTimezone: true, mode: "string" }).default(sql`CURRENT_TIMESTAMP`),
    visibility: varchar({ length: 255 }).default("open_to_organisation"),
    billing_account_id: uuid().notNull(),
    usage_context: varchar({ length: 255 }).default(sql`NULL`),
    data_owner_email: varchar({ length: 255 }).default(sql`NULL`),
    data_owner_org_name: varchar({ length: 255 }).default(sql`NULL`),
    partner_agreement_accepted_at: timestamp({ withTimezone: true, mode: "string" }),
    allow_support_access: boolean().default(false).notNull(),
    context: text(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.billed_to_team_id],
      foreignColumns: [org.id],
      name: "workspace_billed_to_team_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.billed_to_workspace_id],
      foreignColumns: [table.id],
      name: "workspace_billed_to_workspace_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.billing_account_id],
      foreignColumns: [billing_account.id],
      name: "workspace_billing_account_id_foreign",
    }),
    foreignKey({
      columns: [table.created_by],
      foreignColumns: [app_user.id],
      name: "workspace_created_by_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.effective_client_team_id],
      foreignColumns: [org.id],
      name: "workspace_effective_client_team_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.handoff_target_team_id],
      foreignColumns: [org.id],
      name: "workspace_handoff_target_team_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.org_id],
      foreignColumns: [org.id],
      name: "workspace_org_id_foreign",
    }).onDelete("cascade"),
  ],
);

export const announcement_activity = pgTable(
  "announcement_activity",
  {
    announcement_activity: uuid(),
    created_at: timestamp({ withTimezone: true, mode: "string" }),
    id: uuid().primaryKey().notNull(),
    read: boolean().default(false),
    sort: integer(),
    updated_at: timestamp({ withTimezone: true, mode: "string" }),
    user_created: uuid(),
    user_id: uuid(),
    user_updated: uuid(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.announcement_activity],
      foreignColumns: [announcement.id],
      name: "announcement_activity_announcement_activity_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.user_created],
      foreignColumns: [directus_users.id],
      name: "announcement_activity_user_created_foreign",
    }),
    foreignKey({
      columns: [table.user_updated],
      foreignColumns: [directus_users.id],
      name: "announcement_activity_user_updated_foreign",
    }),
  ],
);

export const directus_files = pgTable(
  "directus_files",
  {
    id: uuid().primaryKey().notNull(),
    storage: varchar({ length: 255 }).notNull(),
    filename_disk: varchar({ length: 255 }),
    filename_download: varchar({ length: 255 }).notNull(),
    title: varchar({ length: 255 }),
    type: varchar({ length: 255 }),
    folder: uuid(),
    uploaded_by: uuid(),
    created_on: timestamp({ withTimezone: true, mode: "string" })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    modified_by: uuid(),
    modified_on: timestamp({ withTimezone: true, mode: "string" })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    charset: varchar({ length: 50 }),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    filesize: bigint({ mode: "number" }),
    width: integer(),
    height: integer(),
    duration: integer(),
    embed: varchar({ length: 200 }),
    description: text(),
    location: text(),
    tags: text(),
    metadata: json(),
    focal_point_x: integer(),
    focal_point_y: integer(),
    tus_id: varchar({ length: 64 }),
    tus_data: json(),
    uploaded_on: timestamp({ withTimezone: true, mode: "string" }),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.folder],
      foreignColumns: [directus_folders.id],
      name: "directus_files_folder_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.modified_by],
      foreignColumns: [directus_users.id],
      name: "directus_files_modified_by_foreign",
    }),
    foreignKey({
      columns: [table.uploaded_by],
      foreignColumns: [directus_users.id],
      name: "directus_files_uploaded_by_foreign",
    }),
  ],
);

export const directus_sessions = pgTable(
  "directus_sessions",
  {
    token: varchar({ length: 64 }).primaryKey().notNull(),
    user: uuid(),
    expires: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    ip: varchar({ length: 255 }),
    user_agent: text(),
    share: uuid(),
    origin: varchar({ length: 255 }),
    next_token: varchar({ length: 64 }),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.share],
      foreignColumns: [directus_shares.id],
      name: "directus_sessions_share_foreign",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.user],
      foreignColumns: [directus_users.id],
      name: "directus_sessions_user_foreign",
    }).onDelete("cascade"),
  ],
);

export const methodology_version = pgTable(
  "methodology_version",
  {
    content: json().notNull(),
    created_at: timestamp({ withTimezone: true, mode: "string" }),
    created_by: varchar({ length: 255 }).default(sql`NULL`),
    id: uuid().primaryKey().notNull(),
    methodology_id: uuid(),
    note: varchar({ length: 255 }).default(sql`NULL`),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.methodology_id],
      foreignColumns: [methodology.id],
      name: "methodology_version_methodology_id_foreign",
    }).onDelete("set null"),
  ],
);

export const project_agentic_run_event = pgTable(
  "project_agentic_run_event",
  {
    event_type: varchar({ length: 255 }).default(sql`NULL`),
    id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
    payload: json(),
    project_agentic_run_id: uuid(),
    seq: integer(),
    timestamp: timestamp({ withTimezone: true, mode: "string" }).default(sql`CURRENT_TIMESTAMP`),
  },
  (table): PgTableExtraConfigValue[] => [
    // Run events are always read per run in seq order; the pair serves that and the FK.
    index("project_agentic_run_event_run_seq_index").using(
      "btree",
      table.project_agentic_run_id.asc().nullsLast(),
      table.seq.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.project_agentic_run_id],
      foreignColumns: [project_agentic_run.id],
      name: "project_agentic_run_event_project_agentic_run_id_foreign",
    }).onDelete("cascade"),
  ],
);

export const verification_topic = pgTable(
  "verification_topic",
  {
    date_created: timestamp({ withTimezone: true, mode: "string" }),
    date_updated: timestamp({ withTimezone: true, mode: "string" }),
    icon: varchar({ length: 255 }).default(sql`NULL`),
    key: varchar({ length: 255 }).default(sql`NULL`).primaryKey().notNull(),
    project_id: uuid(),
    prompt: text(),
    sort: integer(),
    user_created: uuid(),
    user_updated: uuid(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.project_id],
      foreignColumns: [project.id],
      name: "verification_topic_project_id_foreign",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.user_created],
      foreignColumns: [directus_users.id],
      name: "verification_topic_user_created_foreign",
    }),
    foreignKey({
      columns: [table.user_updated],
      foreignColumns: [directus_users.id],
      name: "verification_topic_user_updated_foreign",
    }),
  ],
);
export * from "./accounts";
export * from "./auth";
export * from "./platform";
export * from "./staff";
