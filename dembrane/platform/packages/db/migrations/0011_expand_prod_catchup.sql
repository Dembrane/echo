-- Expand: creates the analysis, map and recording overage tables, their indexes, constraints,
-- guard functions and triggers where they are missing. The baseline is adopted, never
-- executed, on a database Directus built, and prod has none of these 15 tables (checked
-- 2026-09-28: the features are on echo-next, not yet released to prod); echo-next and fresh
-- databases already have them, so every statement is a no-op there. Without this the analysis, map and
-- overage features fail on prod after cutover. The old stack does not read these tables.
-- It sorts before the contract migration on purpose: a database migrated with the contract
-- held back must still see the contract as newer than everything applied, or drizzle skips it.
CREATE TABLE IF NOT EXISTS "analysis_feedback" (
	"actor_id" varchar(64) DEFAULT NULL NOT NULL,
	"created_at" timestamp with time zone,
	"id" uuid PRIMARY KEY NOT NULL,
	"note" text,
	"object_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"rating" varchar(8) DEFAULT NULL NOT NULL,
	"revision_id" uuid NOT NULL,
	"tags" json NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "analysis_feedback_actor_present" CHECK (length(btrim((actor_id)::text)) > 0),
	CONSTRAINT "analysis_feedback_note_length" CHECK ((note IS NULL) OR (length(note) <= 500)),
	CONSTRAINT "analysis_feedback_rating_valid" CHECK ((rating)::text = ANY (ARRAY[('up'::character varying)::text, ('down'::character varying)::text])),
	CONSTRAINT "analysis_feedback_tags_are_an_array" CHECK (json_typeof(tags) = 'array'::text)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "analysis_last_opened" (
	"id" uuid PRIMARY KEY NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" varchar(64) DEFAULT NULL NOT NULL,
	CONSTRAINT "analysis_last_opened_user_present" CHECK (length(btrim((user_id)::text)) > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "analysis_object" (
	"created_at" timestamp with time zone,
	"current_revision_id" uuid,
	"id" uuid PRIMARY KEY NOT NULL,
	"lineage_key" varchar(255) DEFAULT NULL NOT NULL,
	"project_id" uuid NOT NULL,
	"revision_count" integer DEFAULT 0 NOT NULL,
	"scope_id" uuid,
	"type" varchar(64) DEFAULT NULL NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "analysis_object_revision_count_valid" CHECK (revision_count >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "analysis_object_revision" (
	"actor_id" varchar(64) DEFAULT NULL,
	"attributes" json,
	"content_hash" varchar(64) DEFAULT NULL NOT NULL,
	"created_at" timestamp with time zone,
	"embedding_refs" json,
	"hash_version" varchar(16) DEFAULT 'c14n-v1' NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"object_id" uuid NOT NULL,
	"origin" varchar(16) DEFAULT NULL NOT NULL,
	"parent_revision_id" uuid,
	"payload" json NOT NULL,
	"project_id" uuid NOT NULL,
	"provenance" json NOT NULL,
	"published_at" timestamp with time zone,
	"reason" text,
	"revision_number" integer NOT NULL,
	"run_id" uuid,
	"schema_version" integer NOT NULL,
	"status" varchar(16) DEFAULT NULL NOT NULL,
	"type" varchar(64) DEFAULT NULL NOT NULL,
	"change_kind" varchar(16) DEFAULT NULL,
	CONSTRAINT "analysis_object_revision_change_kind_authored" CHECK ((change_kind IS NULL) OR ((origin)::text = 'authored'::text)),
	CONSTRAINT "analysis_object_revision_change_kind_valid" CHECK ((change_kind IS NULL) OR ((change_kind)::text = ANY (ARRAY[('typo'::character varying)::text, ('clarity'::character varying)::text, ('meaning'::character varying)::text, ('withdraw'::character varying)::text, ('restore'::character varying)::text, ('rollback'::character varying)::text]))),
	CONSTRAINT "analysis_object_revision_generated_provenance" CHECK (((origin)::text <> 'generated'::text) OR ((((provenance)::jsonb ->> 'runId'::text) IS NOT NULL) AND (((provenance)::jsonb ->> 'recipeId'::text) IS NOT NULL))),
	CONSTRAINT "analysis_object_revision_hash_version_valid" CHECK ((hash_version)::text = 'c14n-v1'::text),
	CONSTRAINT "analysis_object_revision_numbers_valid" CHECK ((revision_number >= 1) AND (schema_version >= 1)),
	CONSTRAINT "analysis_object_revision_origin_valid" CHECK ((origin)::text = ANY (ARRAY[('generated'::character varying)::text, ('authored'::character varying)::text, ('imported'::character varying)::text])),
	CONSTRAINT "analysis_object_revision_published_at" CHECK (((status)::text <> 'published'::text) OR (published_at IS NOT NULL)),
	CONSTRAINT "analysis_object_revision_status_valid" CHECK ((status)::text = ANY (ARRAY[('staged'::character varying)::text, ('candidate'::character varying)::text, ('published'::character varying)::text, ('discarded'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "analysis_outbox" (
	"attempts" integer DEFAULT 0 NOT NULL,
	"claim" varchar(64) DEFAULT NULL,
	"consumers" json,
	"created_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"event_type" varchar(64) DEFAULT NULL NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone,
	"payload" json,
	"project_id" uuid NOT NULL,
	"run_id" uuid,
	"scope_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"snapshot_id" uuid,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "analysis_outbox_counters_valid" CHECK ((sequence >= 1) AND (attempts >= 0)),
	CONSTRAINT "analysis_outbox_status_valid" CHECK ((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('dispatching'::character varying)::text, ('delivered'::character varying)::text, ('dead'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "analysis_relation" (
	"attributes" json,
	"basis" varchar(16) DEFAULT NULL NOT NULL,
	"content_hash" varchar(64) DEFAULT NULL NOT NULL,
	"created_at" timestamp with time zone,
	"from_object_id" uuid NOT NULL,
	"from_revision_id" uuid NOT NULL,
	"hash_version" varchar(16) DEFAULT 'c14n-v1' NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"provenance" json,
	"published_at" timestamp with time zone,
	"run_id" uuid,
	"status" varchar(16) DEFAULT NULL NOT NULL,
	"to_object_id" uuid NOT NULL,
	"to_revision_id" uuid NOT NULL,
	"type" varchar(64) DEFAULT NULL NOT NULL,
	CONSTRAINT "analysis_relation_basis_valid" CHECK ((basis)::text = ANY (ARRAY[('extracted'::character varying)::text, ('inferred'::character varying)::text, ('authored'::character varying)::text])),
	CONSTRAINT "analysis_relation_hash_version_valid" CHECK ((hash_version)::text = 'c14n-v1'::text),
	CONSTRAINT "analysis_relation_not_reflexive" CHECK (from_revision_id <> to_revision_id),
	CONSTRAINT "analysis_relation_status_valid" CHECK ((status)::text = ANY (ARRAY[('staged'::character varying)::text, ('published'::character varying)::text, ('discarded'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "analysis_request_key" (
	"created_at" timestamp with time zone,
	"id" uuid PRIMARY KEY NOT NULL,
	"idempotency_key" varchar(255) DEFAULT NULL NOT NULL,
	"mode" varchar(16) DEFAULT NULL NOT NULL,
	"project_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	CONSTRAINT "analysis_request_key_mode_valid" CHECK ((mode)::text = ANY (ARRAY[('refresh'::character varying)::text, ('regenerate'::character varying)::text, ('retry'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "analysis_run" (
	"attempt" integer DEFAULT 0 NOT NULL,
	"checks" json,
	"completed_at" timestamp with time zone,
	"context" json,
	"created_at" timestamp with time zone,
	"definition" json NOT NULL,
	"depends_on" json,
	"epoch" integer DEFAULT 0 NOT NULL,
	"error" text,
	"execution_ref" varchar(128) DEFAULT NULL,
	"hash_version" varchar(16) DEFAULT 'c14n-v1' NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"idempotency_key" varchar(255) DEFAULT NULL NOT NULL,
	"input_fingerprint" varchar(64) DEFAULT NULL,
	"input_manifest" json,
	"lease" varchar(64) DEFAULT NULL,
	"lease_expires_at" timestamp with time zone,
	"metrics" json,
	"mode" varchar(16) DEFAULT NULL NOT NULL,
	"output_manifest" json,
	"parameters" json,
	"progress" json,
	"project_id" uuid NOT NULL,
	"recipe_id" varchar(128) DEFAULT NULL NOT NULL,
	"recipe_version" varchar(64) DEFAULT NULL NOT NULL,
	"request_fingerprint" varchar(64) DEFAULT NULL NOT NULL,
	"request_order" integer NOT NULL,
	"requested_by" varchar(64) DEFAULT NULL,
	"reused_run_id" uuid,
	"scope_id" uuid NOT NULL,
	"started_at" timestamp with time zone,
	"status" varchar(32) DEFAULT NULL NOT NULL,
	"updated_at" timestamp with time zone,
	"writer_fence" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "analysis_run_counters_valid" CHECK ((request_order >= 1) AND (epoch >= 0) AND (attempt >= 0)),
	CONSTRAINT "analysis_run_hash_version_valid" CHECK ((hash_version)::text = 'c14n-v1'::text),
	CONSTRAINT "analysis_run_mode_valid" CHECK ((mode)::text = ANY (ARRAY[('refresh'::character varying)::text, ('regenerate'::character varying)::text, ('retry'::character varying)::text])),
	CONSTRAINT "analysis_run_ready_has_manifest" CHECK (((status)::text <> 'ready'::text) OR (output_manifest IS NOT NULL)),
	CONSTRAINT "analysis_run_running_has_lease" CHECK (((status)::text <> 'running'::text) OR ((lease IS NOT NULL) AND (lease_expires_at IS NOT NULL))),
	CONSTRAINT "analysis_run_status_valid" CHECK ((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('waiting_for_inputs'::character varying)::text, ('running'::character varying)::text, ('needs_review'::character varying)::text, ('ready'::character varying)::text, ('failed'::character varying)::text, ('cancelled'::character varying)::text, ('superseded'::character varying)::text])),
	CONSTRAINT "analysis_run_writer_fence_valid" CHECK (writer_fence >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "analysis_scope" (
	"created_at" timestamp with time zone,
	"current_request_order" integer,
	"current_run_id" uuid,
	"current_snapshot_id" uuid,
	"generation_epoch" integer DEFAULT 0 NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" varchar(16) DEFAULT NULL NOT NULL,
	"next_request_order" integer DEFAULT 1 NOT NULL,
	"project_id" uuid NOT NULL,
	"publication_sequence" integer DEFAULT 0 NOT NULL,
	"recipe_id" varchar(128) DEFAULT NULL,
	"scope_key" varchar(255) DEFAULT NULL NOT NULL,
	"updated_at" timestamp with time zone,
	"view_id" varchar(128) DEFAULT NULL,
	"writer" varchar(16) DEFAULT 'analysis' NOT NULL,
	"writer_fence" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "analysis_scope_counters_valid" CHECK ((next_request_order >= 1) AND (generation_epoch >= 0) AND (publication_sequence >= 0) AND (writer_fence >= 0) AND ((current_request_order IS NULL) OR (current_request_order >= 1))),
	CONSTRAINT "analysis_scope_kind_valid" CHECK ((((kind)::text = 'producer'::text) AND (recipe_id IS NOT NULL) AND (view_id IS NULL) AND (current_snapshot_id IS NULL)) OR (((kind)::text = 'view'::text) AND (view_id IS NOT NULL) AND (recipe_id IS NULL) AND (current_run_id IS NULL))),
	CONSTRAINT "analysis_scope_writer_valid" CHECK ((writer)::text = ANY (ARRAY[('legacy'::character varying)::text, ('analysis'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "analysis_snapshot" (
	"content_hash" varchar(64) DEFAULT NULL NOT NULL,
	"created_at" timestamp with time zone,
	"created_by" varchar(64) DEFAULT NULL,
	"embedding_config" json,
	"hash_version" varchar(16) DEFAULT 'c14n-v1' NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"manifest" json NOT NULL,
	"manifest_version" integer DEFAULT 1 NOT NULL,
	"parent_snapshot_id" uuid,
	"project_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"settings" json,
	"source_event_id" uuid,
	"versions" json,
	"view_id" varchar(128) DEFAULT NULL NOT NULL,
	CONSTRAINT "analysis_snapshot_hash_version_valid" CHECK ((hash_version)::text = 'c14n-v1'::text),
	CONSTRAINT "analysis_snapshot_manifest_version_valid" CHECK (manifest_version >= 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "analysis_step" (
	"attempt" integer DEFAULT 1 NOT NULL,
	"cache_key" varchar(64) DEFAULT NULL NOT NULL,
	"checkpoint" json,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone,
	"error" text,
	"hash_version" varchar(16) DEFAULT 'c14n-v1' NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" varchar(16) DEFAULT NULL NOT NULL,
	"lease" varchar(64) DEFAULT NULL,
	"output" json,
	"project_id" uuid NOT NULL,
	"reused_step_id" uuid,
	"run_id" uuid NOT NULL,
	"status" varchar(16) DEFAULT NULL NOT NULL,
	"step_key" varchar(128) DEFAULT NULL NOT NULL,
	"step_version" varchar(64) DEFAULT NULL NOT NULL,
	"updated_at" timestamp with time zone,
	"usage" json,
	"validation" json,
	CONSTRAINT "analysis_step_attempt_valid" CHECK (attempt >= 1),
	CONSTRAINT "analysis_step_hash_version_valid" CHECK ((hash_version)::text = 'c14n-v1'::text),
	CONSTRAINT "analysis_step_kind_valid" CHECK ((kind)::text = ANY (ARRAY[('model'::character varying)::text, ('deterministic'::character varying)::text, ('check'::character varying)::text])),
	CONSTRAINT "analysis_step_status_valid" CHECK ((status)::text = ANY (ARRAY[('running'::character varying)::text, ('completed'::character varying)::text, ('failed'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "map_embedding" (
	"config_key" varchar(64) DEFAULT NULL NOT NULL,
	"created_at" timestamp with time zone,
	"dims" integer NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"input_hash" varchar(64) DEFAULT NULL NOT NULL,
	"model" varchar(255) DEFAULT NULL NOT NULL,
	"project_id" uuid NOT NULL,
	"embedding" vector NOT NULL,
	CONSTRAINT "map_embedding_dims_match" CHECK ((dims > 0) AND (vector_dims(embedding) = dims)),
	CONSTRAINT "map_embedding_nonzero" CHECK (vector_norm(embedding) > (0)::double precision)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "map_fact_check" (
	"attempt" integer DEFAULT 0 NOT NULL,
	"claim_key" varchar(64) DEFAULT NULL NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone,
	"error" text,
	"id" uuid PRIMARY KEY NOT NULL,
	"justification" text,
	"model" varchar(255) DEFAULT NULL,
	"project_id" uuid NOT NULL,
	"prompt_version" varchar(128) DEFAULT NULL,
	"requested_by" varchar(64) DEFAULT NULL,
	"sources" json,
	"started_at" timestamp with time zone,
	"statement" text NOT NULL,
	"status" varchar(32) DEFAULT NULL NOT NULL,
	"updated_at" timestamp with time zone,
	"verdict" varchar(32) DEFAULT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "map_result" (
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone,
	"embedding_config" json,
	"error" text,
	"execution_ref" varchar(128) DEFAULT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"manifest" json,
	"manifest_version" integer DEFAULT 1 NOT NULL,
	"progress" json,
	"project_id" uuid NOT NULL,
	"recipe_version" varchar(64) DEFAULT NULL NOT NULL,
	"requested_by" varchar(64) DEFAULT NULL,
	"snapshot_id" uuid,
	"source_fingerprint" varchar(64) DEFAULT NULL,
	"status" varchar(32) DEFAULT NULL NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "map_result_manifest_version_valid" CHECK (manifest_version = ANY (ARRAY[1, 2]))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "recording_overage" (
	"billing_account_id" uuid,
	"cap" integer,
	"closed_notified_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"excess" integer,
	"id" uuid PRIMARY KEY NOT NULL,
	"opened_by_project_id" uuid,
	"opened_notified_at" timestamp with time zone,
	"peak" integer,
	"started_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "analysis_feedback" ADD CONSTRAINT "analysis_feedback_object_id_foreign" FOREIGN KEY ("object_id") REFERENCES "public"."analysis_object"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "analysis_feedback" ADD CONSTRAINT "analysis_feedback_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "analysis_feedback" ADD CONSTRAINT "analysis_feedback_revision_id_foreign" FOREIGN KEY ("revision_id") REFERENCES "public"."analysis_object_revision"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "analysis_last_opened" ADD CONSTRAINT "analysis_last_opened_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "analysis_object" ADD CONSTRAINT "analysis_object_current_revision_id_foreign" FOREIGN KEY ("current_revision_id") REFERENCES "public"."analysis_object_revision"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "analysis_object" ADD CONSTRAINT "analysis_object_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "analysis_object" ADD CONSTRAINT "analysis_object_scope_id_foreign" FOREIGN KEY ("scope_id") REFERENCES "public"."analysis_scope"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "analysis_object_revision" ADD CONSTRAINT "analysis_object_revision_object_id_foreign" FOREIGN KEY ("object_id") REFERENCES "public"."analysis_object"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "analysis_object_revision" ADD CONSTRAINT "analysis_object_revision_parent_revision_id_foreign" FOREIGN KEY ("parent_revision_id") REFERENCES "public"."analysis_object_revision"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "analysis_object_revision" ADD CONSTRAINT "analysis_object_revision_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "analysis_object_revision" ADD CONSTRAINT "analysis_object_revision_run_id_foreign" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_run"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "analysis_outbox" ADD CONSTRAINT "analysis_outbox_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "analysis_outbox" ADD CONSTRAINT "analysis_outbox_run_id_foreign" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_run"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "analysis_outbox" ADD CONSTRAINT "analysis_outbox_scope_id_foreign" FOREIGN KEY ("scope_id") REFERENCES "public"."analysis_scope"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "analysis_outbox" ADD CONSTRAINT "analysis_outbox_snapshot_id_foreign" FOREIGN KEY ("snapshot_id") REFERENCES "public"."analysis_snapshot"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "analysis_relation" ADD CONSTRAINT "analysis_relation_from_object_id_foreign" FOREIGN KEY ("from_object_id") REFERENCES "public"."analysis_object"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "analysis_relation" ADD CONSTRAINT "analysis_relation_from_revision_id_foreign" FOREIGN KEY ("from_revision_id") REFERENCES "public"."analysis_object_revision"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "analysis_relation" ADD CONSTRAINT "analysis_relation_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "analysis_relation" ADD CONSTRAINT "analysis_relation_run_id_foreign" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_run"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "analysis_relation" ADD CONSTRAINT "analysis_relation_to_object_id_foreign" FOREIGN KEY ("to_object_id") REFERENCES "public"."analysis_object"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "analysis_relation" ADD CONSTRAINT "analysis_relation_to_revision_id_foreign" FOREIGN KEY ("to_revision_id") REFERENCES "public"."analysis_object_revision"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "analysis_request_key" ADD CONSTRAINT "analysis_request_key_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "analysis_request_key" ADD CONSTRAINT "analysis_request_key_run_id_foreign" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_run"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "analysis_request_key" ADD CONSTRAINT "analysis_request_key_scope_id_foreign" FOREIGN KEY ("scope_id") REFERENCES "public"."analysis_scope"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "analysis_run" ADD CONSTRAINT "analysis_run_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "analysis_run" ADD CONSTRAINT "analysis_run_reused_run_id_foreign" FOREIGN KEY ("reused_run_id") REFERENCES "public"."analysis_run"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "analysis_run" ADD CONSTRAINT "analysis_run_scope_id_foreign" FOREIGN KEY ("scope_id") REFERENCES "public"."analysis_scope"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "analysis_scope" ADD CONSTRAINT "analysis_scope_current_run_id_foreign" FOREIGN KEY ("current_run_id") REFERENCES "public"."analysis_run"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "analysis_scope" ADD CONSTRAINT "analysis_scope_current_snapshot_id_foreign" FOREIGN KEY ("current_snapshot_id") REFERENCES "public"."analysis_snapshot"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "analysis_scope" ADD CONSTRAINT "analysis_scope_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "analysis_snapshot" ADD CONSTRAINT "analysis_snapshot_parent_snapshot_id_foreign" FOREIGN KEY ("parent_snapshot_id") REFERENCES "public"."analysis_snapshot"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "analysis_snapshot" ADD CONSTRAINT "analysis_snapshot_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "analysis_snapshot" ADD CONSTRAINT "analysis_snapshot_scope_id_foreign" FOREIGN KEY ("scope_id") REFERENCES "public"."analysis_scope"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "analysis_step" ADD CONSTRAINT "analysis_step_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "analysis_step" ADD CONSTRAINT "analysis_step_reused_step_id_foreign" FOREIGN KEY ("reused_step_id") REFERENCES "public"."analysis_step"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "analysis_step" ADD CONSTRAINT "analysis_step_run_id_foreign" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_run"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "map_embedding" ADD CONSTRAINT "map_embedding_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "map_fact_check" ADD CONSTRAINT "map_fact_check_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "map_result" ADD CONSTRAINT "map_result_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "map_result" ADD CONSTRAINT "map_result_snapshot_id_foreign" FOREIGN KEY ("snapshot_id") REFERENCES "public"."analysis_snapshot"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "recording_overage" ADD CONSTRAINT "recording_overage_billing_account_id_foreign" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_account"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "analysis_feedback_project_object_actor" ON "analysis_feedback" USING btree ("project_id","object_id","actor_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "analysis_last_opened_project_user" ON "analysis_last_opened" USING btree ("project_id","user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "analysis_object_project_lineage" ON "analysis_object" USING btree ("project_id","type","lineage_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "analysis_object_revision_object_number" ON "analysis_object_revision" USING btree ("object_id","revision_number");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "analysis_object_revision_one_staged_per_run" ON "analysis_object_revision" USING btree ("run_id","object_id") WHERE ((status)::text = ANY (ARRAY[('staged'::character varying)::text, ('candidate'::character varying)::text]));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analysis_object_revision_run_status" ON "analysis_object_revision" USING btree ("run_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analysis_outbox_due" ON "analysis_outbox" USING btree ("next_attempt_at","created_at") WHERE ((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('dispatching'::character varying)::text]));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "analysis_outbox_scope_sequence" ON "analysis_outbox" USING btree ("scope_id","sequence");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "analysis_relation_one_staged_per_run" ON "analysis_relation" USING btree ("run_id","type","from_revision_id","to_revision_id") WHERE ((status)::text = 'staged'::text);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analysis_relation_published_from" ON "analysis_relation" USING btree ("from_revision_id","type") WHERE ((status)::text = 'published'::text);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analysis_relation_published_to" ON "analysis_relation" USING btree ("to_revision_id","type") WHERE ((status)::text = 'published'::text);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analysis_relation_run_status" ON "analysis_relation" USING btree ("run_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "analysis_request_key_project_key" ON "analysis_request_key" USING btree ("project_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analysis_request_key_run" ON "analysis_request_key" USING btree ("run_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "analysis_run_one_active_request" ON "analysis_run" USING btree ("scope_id","request_fingerprint") WHERE ((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('waiting_for_inputs'::character varying)::text, ('running'::character varying)::text]));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "analysis_run_project_idempotency" ON "analysis_run" USING btree ("project_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analysis_run_running_expiry" ON "analysis_run" USING btree ("lease_expires_at","id") WHERE ((status)::text = 'running'::text);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analysis_run_running_lease" ON "analysis_run" USING btree ("recipe_id","lease_expires_at") WHERE ((status)::text = 'running'::text);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "analysis_run_scope_request_order" ON "analysis_run" USING btree ("scope_id","request_order");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analysis_run_scope_status_created" ON "analysis_run" USING btree ("scope_id","status","created_at" DESC NULLS FIRST);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analysis_run_waiting_by_project" ON "analysis_run" USING btree ("project_id","created_at") WHERE ((status)::text = 'waiting_for_inputs'::text);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "analysis_scope_producer_identity" ON "analysis_scope" USING btree ("project_id","recipe_id","scope_key") WHERE ((kind)::text = 'producer'::text);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "analysis_scope_view_identity" ON "analysis_scope" USING btree ("project_id","view_id","scope_key") WHERE ((kind)::text = 'view'::text);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analysis_snapshot_scope_created" ON "analysis_snapshot" USING btree ("scope_id","created_at" DESC NULLS FIRST);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "analysis_snapshot_scope_source_event" ON "analysis_snapshot" USING btree ("scope_id","source_event_id") WHERE (source_event_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analysis_step_project_cache" ON "analysis_step" USING btree ("project_id","cache_key","completed_at" DESC NULLS FIRST) WHERE (((status)::text = 'completed'::text) AND (reused_step_id IS NULL));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "analysis_step_run_step" ON "analysis_step" USING btree ("run_id","step_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "map_embedding_project_input_config" ON "map_embedding" USING btree ("project_id","input_hash","config_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "map_fact_check_project_claim" ON "map_fact_check" USING btree ("project_id","claim_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "map_result_one_active_attempt" ON "map_result" USING btree ("project_id") WHERE ((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('extracting'::character varying)::text, ('embedding'::character varying)::text]));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "map_result_project_status_created" ON "map_result" USING btree ("project_id","status","created_at" DESC NULLS FIRST);
--> statement-breakpoint
-- Guard functions and triggers on the analysis and map tables, carried over verbatim from
-- echo main. Drizzle does not model them, so they live here. They keep invariants the
-- analysis engine relies on (immutable snapshots, legal state transitions, scope checks)
-- until those checks move into the analysis package and these can be dropped.

CREATE OR REPLACE FUNCTION public.analysis_feedback_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM analysis_object o WHERE o.id = NEW.object_id AND o.project_id = NEW.project_id
    ) THEN
        PERFORM analysis_reference_violation('analysis_feedback.object_id must belong to the same project');
    END IF;
    -- The wording the host was rating, and of the finding they were rating.
    IF NOT EXISTS (
        SELECT 1 FROM analysis_object_revision r
        WHERE r.id = NEW.revision_id AND r.project_id = NEW.project_id AND r.object_id = NEW.object_id
    ) THEN
        PERFORM analysis_reference_violation('analysis_feedback.revision_id must be a revision of this object');
    END IF;
    RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.analysis_object_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.scope_id IS NOT NULL
        AND (TG_OP = 'INSERT' OR NEW.scope_id IS DISTINCT FROM OLD.scope_id)
        AND NOT EXISTS (
            SELECT 1 FROM analysis_scope s WHERE s.id = NEW.scope_id AND s.project_id = NEW.project_id
        ) THEN
        PERFORM analysis_reference_violation('analysis_object.scope_id must belong to the same project');
    END IF;
    IF NEW.current_revision_id IS NOT NULL
        AND (TG_OP = 'INSERT' OR NEW.current_revision_id IS DISTINCT FROM OLD.current_revision_id)
        AND NOT EXISTS (
            SELECT 1 FROM analysis_object_revision v
            WHERE v.id = NEW.current_revision_id AND v.project_id = NEW.project_id
              AND v.object_id = NEW.id AND v.status = 'published'
        ) THEN
        PERFORM analysis_reference_violation('analysis_object.current_revision_id must be a published revision of this object');
    END IF;
    IF TG_OP = 'UPDATE' AND (NEW.type IS DISTINCT FROM OLD.type
                             OR NEW.lineage_key IS DISTINCT FROM OLD.lineage_key
                             OR NEW.project_id IS DISTINCT FROM OLD.project_id) THEN
        PERFORM analysis_reference_violation('an analysis_object keeps its project, type and lineage key');
    END IF;
    RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.analysis_object_revision_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.object_id IS DISTINCT FROM OLD.object_id
        OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.type IS DISTINCT FROM OLD.type THEN
        IF NOT EXISTS (
            SELECT 1 FROM analysis_object o
            WHERE o.id = NEW.object_id AND o.project_id = NEW.project_id AND o.type = NEW.type
        ) THEN
            PERFORM analysis_reference_violation('analysis_object_revision must match its object''s project and type');
        END IF;
    END IF;
    IF NEW.run_id IS NOT NULL
        AND (TG_OP = 'INSERT' OR NEW.run_id IS DISTINCT FROM OLD.run_id)
        AND NOT EXISTS (
            SELECT 1 FROM analysis_run r WHERE r.id = NEW.run_id AND r.project_id = NEW.project_id
        ) THEN
        PERFORM analysis_reference_violation('analysis_object_revision.run_id must belong to the same project');
    END IF;
    IF NEW.parent_revision_id IS NOT NULL
        AND (TG_OP = 'INSERT' OR NEW.parent_revision_id IS DISTINCT FROM OLD.parent_revision_id)
        AND NOT EXISTS (
            SELECT 1 FROM analysis_object_revision p
            WHERE p.id = NEW.parent_revision_id AND p.project_id = NEW.project_id
              AND p.object_id = NEW.object_id
        ) THEN
        PERFORM analysis_reference_violation('analysis_object_revision.parent_revision_id must be a revision of the same object');
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'published' AND (
        NEW.status IS DISTINCT FROM OLD.status
        OR NEW.object_id IS DISTINCT FROM OLD.object_id
        OR NEW.revision_number IS DISTINCT FROM OLD.revision_number
        OR NEW.type IS DISTINCT FROM OLD.type
        OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
        OR NEW.origin IS DISTINCT FROM OLD.origin
        OR NEW.payload::jsonb IS DISTINCT FROM OLD.payload::jsonb
        OR NEW.attributes::jsonb IS DISTINCT FROM OLD.attributes::jsonb
        OR NEW.provenance::jsonb IS DISTINCT FROM OLD.provenance::jsonb
        OR NEW.embedding_refs::jsonb IS DISTINCT FROM OLD.embedding_refs::jsonb
        OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
        OR NEW.change_kind IS DISTINCT FROM OLD.change_kind
        OR NEW.published_at IS DISTINCT FROM OLD.published_at
        OR (NEW.run_id IS DISTINCT FROM OLD.run_id AND NEW.run_id IS NOT NULL)
        OR (NEW.parent_revision_id IS DISTINCT FROM OLD.parent_revision_id AND NEW.parent_revision_id IS NOT NULL)
    ) THEN
        PERFORM analysis_reference_violation('a published analysis_object_revision is immutable');
    END IF;
    RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.analysis_outbox_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF (TG_OP = 'INSERT' OR NEW.scope_id IS DISTINCT FROM OLD.scope_id)
        AND NOT EXISTS (
            SELECT 1 FROM analysis_scope s WHERE s.id = NEW.scope_id AND s.project_id = NEW.project_id
        ) THEN
        PERFORM analysis_reference_violation('analysis_outbox.scope_id must belong to the same project');
    END IF;
    IF NEW.run_id IS NOT NULL
        AND (TG_OP = 'INSERT' OR NEW.run_id IS DISTINCT FROM OLD.run_id)
        AND NOT EXISTS (
            SELECT 1 FROM analysis_run r WHERE r.id = NEW.run_id AND r.project_id = NEW.project_id
        ) THEN
        PERFORM analysis_reference_violation('analysis_outbox.run_id must belong to the same project');
    END IF;
    IF NEW.snapshot_id IS NOT NULL
        AND (TG_OP = 'INSERT' OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id)
        AND NOT EXISTS (
            SELECT 1 FROM analysis_snapshot s WHERE s.id = NEW.snapshot_id AND s.project_id = NEW.project_id
        ) THEN
        PERFORM analysis_reference_violation('analysis_outbox.snapshot_id must belong to the same project');
    END IF;
    RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.analysis_reference_violation(message text) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION '%', message USING ERRCODE = 'check_violation';
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.analysis_relation_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.from_revision_id IS DISTINCT FROM OLD.from_revision_id
        OR NEW.from_object_id IS DISTINCT FROM OLD.from_object_id
        OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
        IF NOT EXISTS (
            SELECT 1 FROM analysis_object_revision v
            WHERE v.id = NEW.from_revision_id AND v.project_id = NEW.project_id
              AND v.object_id = NEW.from_object_id
        ) THEN
            PERFORM analysis_reference_violation('analysis_relation.from_revision_id must be a revision of from_object_id in the same project');
        END IF;
    END IF;
    IF TG_OP = 'INSERT' OR NEW.to_revision_id IS DISTINCT FROM OLD.to_revision_id
        OR NEW.to_object_id IS DISTINCT FROM OLD.to_object_id
        OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
        IF NOT EXISTS (
            SELECT 1 FROM analysis_object_revision v
            WHERE v.id = NEW.to_revision_id AND v.project_id = NEW.project_id
              AND v.object_id = NEW.to_object_id
        ) THEN
            PERFORM analysis_reference_violation('analysis_relation.to_revision_id must be a revision of to_object_id in the same project');
        END IF;
    END IF;
    IF NEW.run_id IS NOT NULL
        AND (TG_OP = 'INSERT' OR NEW.run_id IS DISTINCT FROM OLD.run_id)
        AND NOT EXISTS (
            SELECT 1 FROM analysis_run r WHERE r.id = NEW.run_id AND r.project_id = NEW.project_id
        ) THEN
        PERFORM analysis_reference_violation('analysis_relation.run_id must belong to the same project');
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'published' AND (
        NEW.status IS DISTINCT FROM OLD.status
        OR NEW.type IS DISTINCT FROM OLD.type
        OR NEW.basis IS DISTINCT FROM OLD.basis
        OR NEW.from_revision_id IS DISTINCT FROM OLD.from_revision_id
        OR NEW.to_revision_id IS DISTINCT FROM OLD.to_revision_id
        OR NEW.attributes::jsonb IS DISTINCT FROM OLD.attributes::jsonb
        OR NEW.provenance::jsonb IS DISTINCT FROM OLD.provenance::jsonb
        OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
        OR (NEW.run_id IS DISTINCT FROM OLD.run_id AND NEW.run_id IS NOT NULL)
    ) THEN
        PERFORM analysis_reference_violation('a published analysis_relation is immutable');
    END IF;
    RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.analysis_request_key_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND (NEW.project_id, NEW.idempotency_key, NEW.run_id, NEW.scope_id)
        IS DISTINCT FROM (OLD.project_id, OLD.idempotency_key, OLD.run_id, OLD.scope_id) THEN
        PERFORM analysis_reference_violation('an analysis_request_key is immutable');
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM analysis_run r
        WHERE r.id = NEW.run_id AND r.project_id = NEW.project_id AND r.scope_id = NEW.scope_id
    ) THEN
        PERFORM analysis_reference_violation('analysis_request_key.run_id must be a run of this project and scope');
    END IF;
    RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.analysis_run_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.scope_id IS DISTINCT FROM OLD.scope_id
        OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
        IF NOT EXISTS (
            SELECT 1 FROM analysis_scope s
            WHERE s.id = NEW.scope_id AND s.project_id = NEW.project_id
              AND s.kind = 'producer' AND s.recipe_id = NEW.recipe_id
        ) THEN
            PERFORM analysis_reference_violation('analysis_run.scope_id must be a producer scope of this project and recipe');
        END IF;
    END IF;
    IF NEW.reused_run_id IS NOT NULL
        AND (TG_OP = 'INSERT' OR NEW.reused_run_id IS DISTINCT FROM OLD.reused_run_id)
        AND NOT EXISTS (
            SELECT 1 FROM analysis_run r WHERE r.id = NEW.reused_run_id AND r.project_id = NEW.project_id
        ) THEN
        PERFORM analysis_reference_violation('analysis_run.reused_run_id must belong to the same project');
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'ready'
        AND (NEW.status IS DISTINCT FROM OLD.status
             OR NEW.output_manifest::jsonb IS DISTINCT FROM OLD.output_manifest::jsonb
             OR NEW.input_manifest::jsonb IS DISTINCT FROM OLD.input_manifest::jsonb) THEN
        PERFORM analysis_reference_violation('a ready analysis_run is immutable');
    END IF;
    -- Pinned inputs are written once.
    IF TG_OP = 'UPDATE' AND OLD.input_manifest IS NOT NULL
        AND (NEW.input_manifest::jsonb IS DISTINCT FROM OLD.input_manifest::jsonb
             OR NEW.input_fingerprint IS DISTINCT FROM OLD.input_fingerprint) THEN
        PERFORM analysis_reference_violation('an analysis_run''s pinned inputs are immutable');
    END IF;
    RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.analysis_scope_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.current_run_id IS NOT NULL
        AND (TG_OP = 'INSERT' OR NEW.current_run_id IS DISTINCT FROM OLD.current_run_id)
        AND NOT EXISTS (
            SELECT 1 FROM analysis_run r
            WHERE r.id = NEW.current_run_id AND r.project_id = NEW.project_id
              AND r.scope_id = NEW.id AND r.status = 'ready'
        ) THEN
        PERFORM analysis_reference_violation('analysis_scope.current_run_id must be a ready run of this scope');
    END IF;
    IF NEW.current_snapshot_id IS NOT NULL
        AND (TG_OP = 'INSERT' OR NEW.current_snapshot_id IS DISTINCT FROM OLD.current_snapshot_id)
        AND NOT EXISTS (
            SELECT 1 FROM analysis_snapshot s
            WHERE s.id = NEW.current_snapshot_id AND s.project_id = NEW.project_id AND s.scope_id = NEW.id
        ) THEN
        PERFORM analysis_reference_violation('analysis_scope.current_snapshot_id must be a snapshot of this scope');
    END IF;
    RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.analysis_snapshot_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        -- Only the parent reference may change, and only to NULL (its parent
        -- was deleted). Every other column, settings included, stays.
        IF NEW.parent_snapshot_id IS NULL AND OLD.parent_snapshot_id IS NOT NULL
            AND (to_jsonb(NEW) - 'parent_snapshot_id') = (to_jsonb(OLD) - 'parent_snapshot_id') THEN
            RETURN NEW;
        END IF;
        PERFORM analysis_reference_violation('an analysis_snapshot is immutable');
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM analysis_scope s
        WHERE s.id = NEW.scope_id AND s.project_id = NEW.project_id
          AND s.kind = 'view' AND s.view_id = NEW.view_id
    ) THEN
        PERFORM analysis_reference_violation('analysis_snapshot.scope_id must be a view scope of this project and view');
    END IF;
    IF NEW.parent_snapshot_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM analysis_snapshot p WHERE p.id = NEW.parent_snapshot_id AND p.project_id = NEW.project_id
    ) THEN
        PERFORM analysis_reference_violation('analysis_snapshot.parent_snapshot_id must belong to the same project');
    END IF;
    RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.analysis_step_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF (TG_OP = 'INSERT' OR NEW.run_id IS DISTINCT FROM OLD.run_id)
        AND NOT EXISTS (
            SELECT 1 FROM analysis_run r WHERE r.id = NEW.run_id AND r.project_id = NEW.project_id
        ) THEN
        PERFORM analysis_reference_violation('analysis_step.run_id must belong to the same project');
    END IF;
    IF NEW.reused_step_id IS NOT NULL
        AND (TG_OP = 'INSERT' OR NEW.reused_step_id IS DISTINCT FROM OLD.reused_step_id)
        AND NOT EXISTS (
            SELECT 1 FROM analysis_step s
            WHERE s.id = NEW.reused_step_id AND s.project_id = NEW.project_id
              AND s.cache_key = NEW.cache_key AND s.status = 'completed'
        ) THEN
        PERFORM analysis_reference_violation('analysis_step.reused_step_id must be a completed step of the same project and cache key');
    END IF;
    -- A completed step is an artifact other runs may reuse: never rewritten.
    IF TG_OP = 'UPDATE' AND OLD.status = 'completed'
        AND ((to_jsonb(NEW) - 'reused_step_id' - 'updated_at') IS DISTINCT FROM
             (to_jsonb(OLD) - 'reused_step_id' - 'updated_at')
             OR (NEW.reused_step_id IS DISTINCT FROM OLD.reused_step_id AND NEW.reused_step_id IS NOT NULL)) THEN
        PERFORM analysis_reference_violation('a completed analysis_step is immutable');
    END IF;
    RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.map_result_snapshot_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.snapshot_id IS NOT NULL
        AND (TG_OP = 'INSERT' OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id)
        AND NOT EXISTS (
            SELECT 1 FROM analysis_snapshot s WHERE s.id = NEW.snapshot_id AND s.project_id = NEW.project_id
        ) THEN
        PERFORM analysis_reference_violation('map_result.snapshot_id must be a snapshot of the same project');
    END IF;
    RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_feedback_guard ON public.analysis_feedback;
--> statement-breakpoint
CREATE TRIGGER analysis_feedback_guard BEFORE INSERT OR UPDATE ON public.analysis_feedback FOR EACH ROW EXECUTE FUNCTION public.analysis_feedback_guard();
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_object_guard ON public.analysis_object;
--> statement-breakpoint
CREATE TRIGGER analysis_object_guard BEFORE INSERT OR UPDATE ON public.analysis_object FOR EACH ROW EXECUTE FUNCTION public.analysis_object_guard();
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_object_revision_guard ON public.analysis_object_revision;
--> statement-breakpoint
CREATE TRIGGER analysis_object_revision_guard BEFORE INSERT OR UPDATE ON public.analysis_object_revision FOR EACH ROW EXECUTE FUNCTION public.analysis_object_revision_guard();
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_outbox_guard ON public.analysis_outbox;
--> statement-breakpoint
CREATE TRIGGER analysis_outbox_guard BEFORE INSERT OR UPDATE ON public.analysis_outbox FOR EACH ROW EXECUTE FUNCTION public.analysis_outbox_guard();
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_relation_guard ON public.analysis_relation;
--> statement-breakpoint
CREATE TRIGGER analysis_relation_guard BEFORE INSERT OR UPDATE ON public.analysis_relation FOR EACH ROW EXECUTE FUNCTION public.analysis_relation_guard();
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_request_key_guard ON public.analysis_request_key;
--> statement-breakpoint
CREATE TRIGGER analysis_request_key_guard BEFORE INSERT OR UPDATE ON public.analysis_request_key FOR EACH ROW EXECUTE FUNCTION public.analysis_request_key_guard();
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_run_guard ON public.analysis_run;
--> statement-breakpoint
CREATE TRIGGER analysis_run_guard BEFORE INSERT OR UPDATE ON public.analysis_run FOR EACH ROW EXECUTE FUNCTION public.analysis_run_guard();
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_scope_guard ON public.analysis_scope;
--> statement-breakpoint
CREATE TRIGGER analysis_scope_guard BEFORE INSERT OR UPDATE ON public.analysis_scope FOR EACH ROW EXECUTE FUNCTION public.analysis_scope_guard();
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_snapshot_guard ON public.analysis_snapshot;
--> statement-breakpoint
CREATE TRIGGER analysis_snapshot_guard BEFORE INSERT OR UPDATE ON public.analysis_snapshot FOR EACH ROW EXECUTE FUNCTION public.analysis_snapshot_guard();
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_step_guard ON public.analysis_step;
--> statement-breakpoint
CREATE TRIGGER analysis_step_guard BEFORE INSERT OR UPDATE ON public.analysis_step FOR EACH ROW EXECUTE FUNCTION public.analysis_step_guard();
--> statement-breakpoint
DROP TRIGGER IF EXISTS map_result_snapshot_guard ON public.map_result;
--> statement-breakpoint
CREATE TRIGGER map_result_snapshot_guard BEFORE INSERT OR UPDATE OF snapshot_id, project_id ON public.map_result FOR EACH ROW EXECUTE FUNCTION public.map_result_snapshot_guard();
