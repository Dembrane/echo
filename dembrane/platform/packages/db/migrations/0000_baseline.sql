-- pgvector backs map_embedding.embedding.
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "access_request" (
	"actioned_at" timestamp with time zone,
	"actioned_by" uuid,
	"deleted_at" timestamp with time zone,
	"id" uuid PRIMARY KEY NOT NULL,
	"requested_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"status" varchar(255) DEFAULT 'pending' NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_audit_event" (
	"app_user_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"duration_ms" integer,
	"grant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid,
	"params" json,
	"status" varchar(255) DEFAULT NULL NOT NULL,
	"tool" varchar(255) DEFAULT NULL NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_client" (
	"client_name" varchar(255) DEFAULT NULL,
	"client_secret_encrypted" text,
	"created_at" timestamp with time zone NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"last_seen_at" timestamp with time zone,
	"metadata" json,
	"redirect_uris" json,
	"token_endpoint_auth_method" varchar(255) DEFAULT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_grant" (
	"app_user_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"client_name" varchar(255) DEFAULT NULL,
	"consent_accepted_at" timestamp with time zone NOT NULL,
	"consent_version" varchar(255) DEFAULT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"directus_user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"last_used_at" timestamp with time zone,
	"org_ids" json,
	"revoked_at" timestamp with time zone,
	"scopes" json
);
--> statement-breakpoint
CREATE TABLE "agent_insight" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone,
	"kind" varchar(255) DEFAULT NULL NOT NULL,
	"content" text NOT NULL,
	"suggested_capability" text,
	"workspace_id" varchar(255) DEFAULT NULL,
	"project_id" varchar(255) DEFAULT NULL,
	"chat_id" varchar(255) DEFAULT NULL,
	"message_id" varchar(255) DEFAULT NULL,
	"status" varchar(255) DEFAULT 'new',
	"source" varchar(255) DEFAULT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_loop" (
	"acting_directus_user_id" varchar(255) DEFAULT NULL,
	"cadence_minutes" integer DEFAULT 5,
	"caps" json,
	"chat_id" varchar(255) DEFAULT NULL,
	"created_at" timestamp with time zone,
	"created_from_chat_id" varchar(255) DEFAULT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"failure_count" integer DEFAULT 0,
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(255) DEFAULT NULL,
	"project_id" uuid,
	"report_id" bigint,
	"status" varchar(255) DEFAULT 'active',
	"updated_at" timestamp with time zone,
	"popcorn_state" json
);
--> statement-breakpoint
CREATE TABLE "agent_loop_run" (
	"detail" text,
	"finished_at" timestamp with time zone,
	"generation_id" uuid,
	"id" uuid PRIMARY KEY NOT NULL,
	"loop_id" uuid,
	"started_at" timestamp with time zone,
	"status" varchar(255) DEFAULT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_memory" (
	"content" text,
	"created_at" timestamp with time zone,
	"directus_user_id" varchar(255) DEFAULT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"memory_key" varchar(255) DEFAULT NULL,
	"project_id" varchar(255) DEFAULT NULL,
	"scope" varchar(255) DEFAULT 'project',
	"source" varchar(255) DEFAULT 'agent',
	"updated_at" timestamp with time zone,
	"workspace_id" varchar(255) DEFAULT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_token" (
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"grant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" varchar(255) DEFAULT NULL NOT NULL,
	"pair_id" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"token_hash" varchar(255) DEFAULT NULL NOT NULL,
	CONSTRAINT "agent_token_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "analysis_feedback" (
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
CREATE TABLE "analysis_last_opened" (
	"id" uuid PRIMARY KEY NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" varchar(64) DEFAULT NULL NOT NULL,
	CONSTRAINT "analysis_last_opened_user_present" CHECK (length(btrim((user_id)::text)) > 0)
);
--> statement-breakpoint
CREATE TABLE "analysis_object" (
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
CREATE TABLE "analysis_object_revision" (
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
CREATE TABLE "analysis_outbox" (
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
CREATE TABLE "analysis_relation" (
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
CREATE TABLE "analysis_request_key" (
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
CREATE TABLE "analysis_run" (
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
CREATE TABLE "analysis_scope" (
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
CREATE TABLE "analysis_snapshot" (
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
CREATE TABLE "analysis_step" (
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
CREATE TABLE "announcement" (
	"created_at" timestamp with time zone,
	"expires_at" timestamp,
	"id" uuid PRIMARY KEY NOT NULL,
	"level" varchar(255) DEFAULT NULL,
	"sort" integer,
	"updated_at" timestamp with time zone,
	"user_created" uuid,
	"user_updated" uuid
);
--> statement-breakpoint
CREATE TABLE "announcement_activity" (
	"announcement_activity" uuid,
	"created_at" timestamp with time zone,
	"id" uuid PRIMARY KEY NOT NULL,
	"read" boolean DEFAULT false,
	"sort" integer,
	"updated_at" timestamp with time zone,
	"user_created" uuid,
	"user_id" uuid,
	"user_updated" uuid
);
--> statement-breakpoint
CREATE TABLE "announcement_translations" (
	"announcement_id" uuid,
	"id" serial PRIMARY KEY NOT NULL,
	"languages_code" varchar(255) DEFAULT NULL,
	"message" text,
	"title" text
);
--> statement-breakpoint
CREATE TABLE "app_user" (
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"directus_user_id" uuid,
	"display_name" varchar(255) DEFAULT NULL,
	"email" varchar(255) DEFAULT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"onboarding_answer_json" json,
	"terms_accepted_at" timestamp with time zone,
	"settings" json,
	CONSTRAINT "app_user_directus_user_id_unique" UNIQUE("directus_user_id")
);
--> statement-breakpoint
CREATE TABLE "aspect" (
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"description" text,
	"id" uuid PRIMARY KEY NOT NULL,
	"image_url" varchar(255) DEFAULT NULL,
	"long_summary" text,
	"name" varchar(255) DEFAULT NULL,
	"short_summary" text,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"view_id" uuid
);
--> statement-breakpoint
CREATE TABLE "aspect_segment" (
	"aspect" uuid,
	"description" text,
	"id" uuid PRIMARY KEY NOT NULL,
	"relevant_index" text,
	"segment" integer,
	"verbatim_transcript" text
);
--> statement-breakpoint
CREATE TABLE "billing_account" (
	"id" uuid PRIMARY KEY NOT NULL,
	"billing_period" varchar(255) DEFAULT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"created_by" uuid,
	"deleted_at" timestamp with time zone,
	"downgraded_at" timestamp with time zone,
	"downgraded_from_tier" varchar(255) DEFAULT NULL,
	"label" varchar(255) DEFAULT NULL,
	"mollie_customer_id" varchar(255) DEFAULT NULL,
	"mollie_subscription_id" varchar(255) DEFAULT NULL,
	"org_id" uuid,
	"payment_mode" varchar(255) DEFAULT 'none' NOT NULL,
	"percent_discount" integer,
	"pre_warning_sent" boolean DEFAULT false NOT NULL,
	"provisioned_seats" integer,
	"status" varchar(255) DEFAULT 'none',
	"tier" varchar(255) DEFAULT 'free' NOT NULL,
	"tier_expires_at" timestamp with time zone,
	"type_discount" varchar(255) DEFAULT NULL,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"workspace_id" uuid,
	"account_manager_id" uuid,
	"billing_address_line1" varchar(255) DEFAULT NULL,
	"billing_address_line2" varchar(255) DEFAULT NULL,
	"billing_city" varchar(255) DEFAULT NULL,
	"billing_country" varchar(255) DEFAULT NULL,
	"billing_legal_name" varchar(255) DEFAULT NULL,
	"billing_postal_code" varchar(255) DEFAULT NULL,
	"billing_vat_id" varchar(255) DEFAULT NULL,
	"billing_vat_region" varchar(255) DEFAULT NULL,
	"payment_failed_notified" boolean DEFAULT false NOT NULL,
	"reconcile_failed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "canvas_config_revision" (
	"brief" text,
	"cadence_minutes" integer DEFAULT 5,
	"created_at" timestamp with time zone,
	"created_by" varchar(255) DEFAULT NULL,
	"gather_spec" json,
	"id" uuid PRIMARY KEY NOT NULL,
	"note" varchar(255) DEFAULT NULL,
	"report_id" bigint,
	"popcorn_settings" json
);
--> statement-breakpoint
CREATE TABLE "canvas_generation" (
	"config_revision_id" uuid,
	"content_html" text,
	"created_at" timestamp with time zone,
	"detail" text,
	"id" uuid PRIMARY KEY NOT NULL,
	"report_id" bigint,
	"status" varchar(255) DEFAULT 'ok',
	"tick_kind" varchar(255) DEFAULT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation" (
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"deleted_at" timestamp with time zone,
	"duration" real,
	"id" uuid PRIMARY KEY NOT NULL,
	"is_all_chunks_transcribed" boolean,
	"is_anonymized" boolean DEFAULT false,
	"is_audio_processing_finished" boolean DEFAULT false,
	"is_finished" boolean DEFAULT false,
	"is_over_cap" boolean DEFAULT false NOT NULL,
	"merged_audio_path" text,
	"merged_transcript" text,
	"participant_email" varchar(255) DEFAULT NULL,
	"participant_name" varchar(255) DEFAULT NULL,
	"participant_user_agent" varchar(255) DEFAULT NULL,
	"project_id" uuid NOT NULL,
	"source" varchar(255) DEFAULT NULL,
	"summary" text,
	"title" text,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"move_history" json,
	"token_count" integer,
	"recording_started_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "conversation_artifact" (
	"approved_at" timestamp with time zone,
	"content" text,
	"conversation_id" uuid,
	"date_created" timestamp with time zone,
	"id" uuid PRIMARY KEY NOT NULL,
	"key" varchar(255) DEFAULT NULL,
	"last_updated_at" timestamp,
	"read_aloud_stream_url" text,
	"topic_label" varchar(255) DEFAULT NULL,
	"user_created" uuid,
	"user_updated" uuid
);
--> statement-breakpoint
CREATE TABLE "conversation_chunk" (
	"conversation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"cross_talk_instances" integer DEFAULT 0,
	"desired_language" varchar(255) DEFAULT NULL,
	"detected_language" varchar(255) DEFAULT NULL,
	"detected_language_confidence" real,
	"diarization" json,
	"error" text,
	"hallucination_reason" text,
	"hallucination_score" real,
	"id" uuid PRIMARY KEY NOT NULL,
	"noise_ratio" real DEFAULT '0',
	"path" varchar(255) DEFAULT NULL,
	"raw_transcript" text,
	"runpod_job_status_link" text,
	"runpod_request_count" integer DEFAULT 0,
	"silence_ratio" real DEFAULT '0',
	"source" varchar(255) DEFAULT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"transcript" text,
	"translation_error" varchar(255) DEFAULT NULL,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "conversation_link" (
	"date_created" timestamp with time zone,
	"date_updated" timestamp with time zone,
	"id" bigserial PRIMARY KEY NOT NULL,
	"link_type" varchar(255) DEFAULT NULL,
	"source_conversation_id" uuid,
	"target_conversation_id" uuid
);
--> statement-breakpoint
CREATE TABLE "conversation_project_tag" (
	"conversation_id" uuid,
	"id" serial PRIMARY KEY NOT NULL,
	"project_tag_id" uuid
);
--> statement-breakpoint
CREATE TABLE "conversation_reply" (
	"content_text" text,
	"conversation_id" varchar(255) DEFAULT NULL,
	"date_created" timestamp with time zone,
	"id" uuid PRIMARY KEY NOT NULL,
	"reply" uuid,
	"sort" integer,
	"type" varchar(255) DEFAULT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_segment" (
	"config_id" varchar(255) DEFAULT NULL,
	"contextual_transcript" text,
	"conversation_id" uuid,
	"counter" real,
	"id" serial PRIMARY KEY NOT NULL,
	"lightrag_flag" boolean DEFAULT false,
	"path" text,
	"transcript" text
);
--> statement-breakpoint
CREATE TABLE "conversation_segment_conversation_chunk" (
	"conversation_chunk_id" uuid,
	"conversation_segment_id" integer,
	"id" serial PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "directus_access" (
	"id" uuid PRIMARY KEY NOT NULL,
	"role" uuid,
	"user" uuid,
	"policy" uuid NOT NULL,
	"sort" integer
);
--> statement-breakpoint
CREATE TABLE "directus_activity" (
	"id" serial PRIMARY KEY NOT NULL,
	"action" varchar(45) NOT NULL,
	"user" uuid,
	"timestamp" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"ip" varchar(50),
	"user_agent" text,
	"collection" varchar(64) NOT NULL,
	"item" varchar(255) NOT NULL,
	"origin" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "directus_collections" (
	"collection" varchar(64) PRIMARY KEY NOT NULL,
	"icon" varchar(64),
	"note" text,
	"display_template" varchar(255),
	"hidden" boolean DEFAULT false NOT NULL,
	"singleton" boolean DEFAULT false NOT NULL,
	"translations" json,
	"archive_field" varchar(64),
	"archive_app_filter" boolean DEFAULT true NOT NULL,
	"archive_value" varchar(255),
	"unarchive_value" varchar(255),
	"sort_field" varchar(64),
	"accountability" varchar(255) DEFAULT 'all',
	"color" varchar(255),
	"item_duplication_fields" json,
	"sort" integer,
	"group" varchar(64),
	"collapse" varchar(255) DEFAULT 'open' NOT NULL,
	"preview_url" varchar(255),
	"versioning" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "directus_comments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"collection" varchar(64) NOT NULL,
	"item" varchar(255) NOT NULL,
	"comment" text NOT NULL,
	"date_created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"date_updated" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"user_created" uuid,
	"user_updated" uuid
);
--> statement-breakpoint
CREATE TABLE "directus_dashboards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"icon" varchar(64) DEFAULT 'dashboard' NOT NULL,
	"note" text,
	"date_created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"user_created" uuid,
	"color" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "directus_extensions" (
	"enabled" boolean DEFAULT true NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"folder" varchar(255) NOT NULL,
	"source" varchar(255) NOT NULL,
	"bundle" uuid
);
--> statement-breakpoint
CREATE TABLE "directus_fields" (
	"id" serial PRIMARY KEY NOT NULL,
	"collection" varchar(64) NOT NULL,
	"field" varchar(64) NOT NULL,
	"special" varchar(64),
	"interface" varchar(64),
	"options" json,
	"display" varchar(64),
	"display_options" json,
	"readonly" boolean DEFAULT false NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"sort" integer,
	"width" varchar(30) DEFAULT 'full',
	"translations" json,
	"note" text,
	"conditions" json,
	"required" boolean DEFAULT false,
	"group" varchar(64),
	"validation" json,
	"validation_message" text,
	"searchable" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "directus_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"storage" varchar(255) NOT NULL,
	"filename_disk" varchar(255),
	"filename_download" varchar(255) NOT NULL,
	"title" varchar(255),
	"type" varchar(255),
	"folder" uuid,
	"uploaded_by" uuid,
	"created_on" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"modified_by" uuid,
	"modified_on" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"charset" varchar(50),
	"filesize" bigint,
	"width" integer,
	"height" integer,
	"duration" integer,
	"embed" varchar(200),
	"description" text,
	"location" text,
	"tags" text,
	"metadata" json,
	"focal_point_x" integer,
	"focal_point_y" integer,
	"tus_id" varchar(64),
	"tus_data" json,
	"uploaded_on" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "directus_flows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"icon" varchar(64),
	"color" varchar(255),
	"description" text,
	"status" varchar(255) DEFAULT 'active' NOT NULL,
	"trigger" varchar(255),
	"accountability" varchar(255) DEFAULT 'all',
	"options" json,
	"operation" uuid,
	"date_created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"user_created" uuid,
	CONSTRAINT "directus_flows_operation_unique" UNIQUE("operation")
);
--> statement-breakpoint
CREATE TABLE "directus_folders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"parent" uuid
);
--> statement-breakpoint
CREATE TABLE "directus_migrations" (
	"version" varchar(255) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"timestamp" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "directus_notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"timestamp" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"status" varchar(255) DEFAULT 'inbox',
	"recipient" uuid NOT NULL,
	"sender" uuid,
	"subject" varchar(255) NOT NULL,
	"message" text,
	"collection" varchar(64),
	"item" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "directus_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(255),
	"key" varchar(255) NOT NULL,
	"type" varchar(255) NOT NULL,
	"position_x" integer NOT NULL,
	"position_y" integer NOT NULL,
	"options" json,
	"resolve" uuid,
	"reject" uuid,
	"flow" uuid NOT NULL,
	"date_created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"user_created" uuid,
	CONSTRAINT "directus_operations_resolve_unique" UNIQUE("resolve"),
	CONSTRAINT "directus_operations_reject_unique" UNIQUE("reject")
);
--> statement-breakpoint
CREATE TABLE "directus_panels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dashboard" uuid NOT NULL,
	"name" varchar(255),
	"icon" varchar(64) DEFAULT NULL,
	"color" varchar(10),
	"show_header" boolean DEFAULT false NOT NULL,
	"note" text,
	"type" varchar(255) NOT NULL,
	"position_x" integer NOT NULL,
	"position_y" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"options" json,
	"date_created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"user_created" uuid
);
--> statement-breakpoint
CREATE TABLE "directus_permissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"collection" varchar(64) NOT NULL,
	"action" varchar(10) NOT NULL,
	"permissions" json,
	"validation" json,
	"presets" json,
	"fields" text,
	"policy" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "directus_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"icon" varchar(64) DEFAULT 'badge' NOT NULL,
	"description" text,
	"ip_access" text,
	"enforce_tfa" boolean DEFAULT false NOT NULL,
	"admin_access" boolean DEFAULT false NOT NULL,
	"app_access" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "directus_presets" (
	"id" serial PRIMARY KEY NOT NULL,
	"bookmark" varchar(255),
	"user" uuid,
	"role" uuid,
	"collection" varchar(64),
	"search" varchar(100),
	"layout" varchar(100) DEFAULT 'tabular',
	"layout_query" json,
	"layout_options" json,
	"refresh_interval" integer,
	"filter" json,
	"icon" varchar(64) DEFAULT 'bookmark',
	"color" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "directus_relations" (
	"id" serial PRIMARY KEY NOT NULL,
	"many_collection" varchar(64) NOT NULL,
	"many_field" varchar(64) NOT NULL,
	"one_collection" varchar(64),
	"one_field" varchar(64),
	"one_collection_field" varchar(64),
	"one_allowed_collections" text,
	"junction_field" varchar(64),
	"sort_field" varchar(64),
	"one_deselect_action" varchar(255) DEFAULT 'nullify' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "directus_revisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"activity" integer NOT NULL,
	"collection" varchar(64) NOT NULL,
	"item" varchar(255) NOT NULL,
	"data" json,
	"delta" json,
	"parent" integer,
	"version" uuid
);
--> statement-breakpoint
CREATE TABLE "directus_roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"icon" varchar(64) DEFAULT 'supervised_user_circle' NOT NULL,
	"description" text,
	"parent" uuid
);
--> statement-breakpoint
CREATE TABLE "directus_sessions" (
	"token" varchar(64) PRIMARY KEY NOT NULL,
	"user" uuid,
	"expires" timestamp with time zone NOT NULL,
	"ip" varchar(255),
	"user_agent" text,
	"share" uuid,
	"origin" varchar(255),
	"next_token" varchar(64)
);
--> statement-breakpoint
CREATE TABLE "directus_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_name" varchar(100) DEFAULT 'Directus' NOT NULL,
	"project_url" varchar(255),
	"project_color" varchar(255) DEFAULT '#6644FF' NOT NULL,
	"project_logo" uuid,
	"public_foreground" uuid,
	"public_background" uuid,
	"public_note" text,
	"auth_login_attempts" integer DEFAULT 25,
	"auth_password_policy" varchar(100),
	"storage_asset_transform" varchar(7) DEFAULT 'all',
	"storage_asset_presets" json,
	"custom_css" text,
	"storage_default_folder" uuid,
	"basemaps" json,
	"mapbox_key" varchar(255),
	"module_bar" json,
	"project_descriptor" varchar(100),
	"default_language" varchar(255) DEFAULT 'en-US' NOT NULL,
	"custom_aspect_ratios" json,
	"public_favicon" uuid,
	"default_appearance" varchar(255) DEFAULT 'auto' NOT NULL,
	"default_theme_light" varchar(255),
	"theme_light_overrides" json,
	"default_theme_dark" varchar(255),
	"theme_dark_overrides" json,
	"report_error_url" varchar(255),
	"report_bug_url" varchar(255),
	"report_feature_url" varchar(255),
	"public_registration" boolean DEFAULT false NOT NULL,
	"public_registration_verify_email" boolean DEFAULT true NOT NULL,
	"public_registration_role" uuid,
	"public_registration_email_filter" json,
	"visual_editor_urls" json,
	"project_id" uuid,
	"mcp_enabled" boolean DEFAULT false NOT NULL,
	"mcp_allow_deletes" boolean DEFAULT false NOT NULL,
	"mcp_prompts_collection" varchar(255) DEFAULT NULL,
	"mcp_system_prompt_enabled" boolean DEFAULT true NOT NULL,
	"mcp_system_prompt" text,
	"project_owner" varchar(255),
	"project_usage" varchar(255),
	"org_name" varchar(255),
	"product_updates" boolean,
	"project_status" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "directus_shares" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(255),
	"collection" varchar(64) NOT NULL,
	"item" varchar(255) NOT NULL,
	"role" uuid,
	"password" varchar(255),
	"user_created" uuid,
	"date_created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"date_start" timestamp with time zone,
	"date_end" timestamp with time zone,
	"times_used" integer DEFAULT 0,
	"max_uses" integer
);
--> statement-breakpoint
CREATE TABLE "directus_sync_id_map" (
	"id" serial PRIMARY KEY NOT NULL,
	"table" varchar(255) NOT NULL,
	"sync_id" varchar(255) NOT NULL,
	"local_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT "directus_sync_id_map_table_local_id_unique" UNIQUE("table","local_id"),
	CONSTRAINT "directus_sync_id_map_table_sync_id_unique" UNIQUE("table","sync_id")
);
--> statement-breakpoint
CREATE TABLE "directus_translations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"language" varchar(255) NOT NULL,
	"key" varchar(255) NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "directus_users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"first_name" varchar(50),
	"last_name" varchar(50),
	"email" varchar(128),
	"password" varchar(255),
	"location" varchar(255),
	"title" varchar(50),
	"description" text,
	"tags" json,
	"avatar" uuid,
	"language" varchar(255) DEFAULT NULL,
	"tfa_secret" varchar(255),
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"role" uuid,
	"token" varchar(255),
	"last_access" timestamp with time zone,
	"last_page" varchar(255),
	"provider" varchar(128) DEFAULT 'default' NOT NULL,
	"external_identifier" varchar(255),
	"auth_data" json,
	"email_notifications" boolean DEFAULT true,
	"appearance" varchar(255),
	"theme_dark" varchar(255),
	"theme_light" varchar(255),
	"theme_light_overrides" json,
	"theme_dark_overrides" json,
	"text_direction" varchar(255) DEFAULT 'auto' NOT NULL,
	"disable_create_project" boolean DEFAULT false,
	"hide_ai_suggestions" boolean DEFAULT false,
	"legal_basis" varchar(255) DEFAULT 'client-managed',
	"privacy_policy_url" varchar(255) DEFAULT NULL,
	"quick_access_preferences" json DEFAULT '[]'::json,
	"whitelabel_logo" uuid,
	CONSTRAINT "directus_users_email_unique" UNIQUE("email"),
	CONSTRAINT "directus_users_token_unique" UNIQUE("token"),
	CONSTRAINT "directus_users_external_identifier_unique" UNIQUE("external_identifier")
);
--> statement-breakpoint
CREATE TABLE "directus_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" varchar(64) NOT NULL,
	"name" varchar(255),
	"collection" varchar(64) NOT NULL,
	"item" varchar(255) NOT NULL,
	"hash" varchar(255),
	"date_created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"date_updated" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"user_created" uuid,
	"user_updated" uuid,
	"delta" json
);
--> statement-breakpoint
CREATE TABLE "directus_webhooks" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"method" varchar(10) DEFAULT 'POST' NOT NULL,
	"url" varchar(255) NOT NULL,
	"status" varchar(10) DEFAULT 'active' NOT NULL,
	"data" boolean DEFAULT true NOT NULL,
	"actions" varchar(100) NOT NULL,
	"collections" varchar(255) NOT NULL,
	"headers" json,
	"was_active_before_deprecation" boolean DEFAULT false NOT NULL,
	"migrated_flow" uuid
);
--> statement-breakpoint
CREATE TABLE "insight" (
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"id" uuid PRIMARY KEY NOT NULL,
	"project_analysis_run_id" uuid,
	"summary" text,
	"title" text,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "languages" (
	"code" varchar(255) PRIMARY KEY DEFAULT NULL NOT NULL,
	"direction" varchar(255) DEFAULT 'ltr',
	"name" varchar(255) DEFAULT NULL
);
--> statement-breakpoint
CREATE TABLE "map_embedding" (
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
CREATE TABLE "map_fact_check" (
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
CREATE TABLE "map_result" (
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
CREATE TABLE "methodology" (
	"created_at" timestamp with time zone,
	"description" text,
	"framing" text,
	"id" uuid PRIMARY KEY NOT NULL,
	"is_seeded" boolean DEFAULT false,
	"name" varchar(255) DEFAULT NULL NOT NULL,
	"owner_directus_user_id" varchar(255) DEFAULT NULL,
	"updated_at" timestamp with time zone,
	"visibility" varchar(255) DEFAULT 'private',
	"workspace_id" uuid
);
--> statement-breakpoint
CREATE TABLE "methodology_version" (
	"content" json NOT NULL,
	"created_at" timestamp with time zone,
	"created_by" varchar(255) DEFAULT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"methodology_id" uuid,
	"note" varchar(255) DEFAULT NULL
);
--> statement-breakpoint
CREATE TABLE "model_response_feedback" (
	"chat_mode" varchar(255) DEFAULT NULL,
	"comment" text,
	"context" json,
	"date_created" timestamp with time zone,
	"date_updated" timestamp with time zone,
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid,
	"rating" varchar(255) DEFAULT NULL NOT NULL,
	"reason" varchar(255) DEFAULT NULL,
	"reasons" json,
	"response_snapshot" text,
	"target_id" varchar(255) DEFAULT NULL NOT NULL,
	"target_type" varchar(255) DEFAULT NULL NOT NULL,
	"user_id" uuid
);
--> statement-breakpoint
CREATE TABLE "notification" (
	"action" varchar(255) DEFAULT 'NONE' NOT NULL,
	"actor_user_id" uuid,
	"audience_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"event_code" varchar(255) DEFAULT NULL NOT NULL,
	"expires_at" timestamp with time zone,
	"id" uuid PRIMARY KEY NOT NULL,
	"message" text,
	"params" json,
	"read_at" timestamp with time zone,
	"ref_chat_id" uuid,
	"ref_conversation_id" uuid,
	"ref_invite_id" uuid,
	"ref_org_id" uuid,
	"ref_project_id" uuid,
	"ref_report_id" varchar(255) DEFAULT NULL,
	"ref_workspace_id" uuid,
	"scope" varchar(255) DEFAULT NULL,
	"severity" varchar(255) DEFAULT 'info' NOT NULL,
	"title" varchar(255) DEFAULT NULL NOT NULL,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "org" (
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"created_by" uuid,
	"deleted_at" timestamp with time zone,
	"id" uuid PRIMARY KEY NOT NULL,
	"logo_url" varchar(255) DEFAULT NULL,
	"name" varchar(255) DEFAULT NULL NOT NULL,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"description" text,
	"is_partner" boolean DEFAULT false NOT NULL,
	"agent_access_enabled" boolean DEFAULT false NOT NULL,
	"agent_access_updated_at" timestamp with time zone,
	"agent_access_updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "org_invite" (
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"deleted_at" timestamp with time zone,
	"email" varchar(255) DEFAULT NULL NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"invited_by" uuid,
	"org_id" uuid NOT NULL,
	"role" varchar(255) DEFAULT 'member' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_membership" (
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"custom_policies" json DEFAULT '[]'::json,
	"deleted_at" timestamp with time zone,
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"role" varchar(255) DEFAULT NULL NOT NULL,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"user_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pricing_configuration" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reference" varchar(255) DEFAULT NULL,
	"config_session_id" varchar(255) DEFAULT NULL NOT NULL,
	"status" varchar(255) DEFAULT 'in_progress',
	"email" varchar(255) DEFAULT NULL,
	"user_id" varchar(255) DEFAULT NULL,
	"is_internal" boolean DEFAULT false NOT NULL,
	"locale" varchar(255) DEFAULT NULL,
	"mount" varchar(255) DEFAULT 'app',
	"wall_key" varchar(255) DEFAULT NULL,
	"workspace_id" varchar(255) DEFAULT NULL,
	"org_id" varchar(255) DEFAULT NULL,
	"project_id" varchar(255) DEFAULT NULL,
	"question_set_version" varchar(255) DEFAULT NULL,
	"config_shape_version" integer,
	"answers_raw" json,
	"config" json,
	"volume_bucket" varchar(255) DEFAULT NULL,
	"concurrency_bucket" varchar(255) DEFAULT NULL,
	"concurrency_exact" integer,
	"answered_count" integer,
	"furthest_step" integer,
	"voice_transcript" text,
	"voice_audio" json,
	"booking_status" varchar(255) DEFAULT 'none',
	"booking_uid" varchar(255) DEFAULT NULL,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"booking_notified_at" timestamp with time zone,
	CONSTRAINT "pricing_configuration_reference_unique" UNIQUE("reference"),
	CONSTRAINT "pricing_configuration_config_session_id_unique" UNIQUE("config_session_id")
);
--> statement-breakpoint
CREATE TABLE "processing_status" (
	"conversation_chunk_id" uuid,
	"conversation_id" uuid,
	"duration_ms" integer,
	"event" varchar(255) DEFAULT NULL,
	"id" bigserial PRIMARY KEY NOT NULL,
	"message" text,
	"parent" bigint,
	"project_analysis_run_id" uuid,
	"project_id" uuid,
	"timestamp" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "project" (
	"anonymize_transcripts" boolean DEFAULT false,
	"context" text,
	"conversation_ask_for_participant_name_label" varchar(255) DEFAULT NULL,
	"conversation_title_prompt" text,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"default_conversation_ask_for_participant_email" boolean DEFAULT false,
	"default_conversation_ask_for_participant_name" boolean DEFAULT true,
	"default_conversation_description" text,
	"default_conversation_finish_text" text,
	"default_conversation_title" varchar(255) DEFAULT NULL,
	"default_conversation_transcript_prompt" text,
	"default_conversation_tutorial_slug" varchar(255) DEFAULT 'none',
	"deleted_at" timestamp with time zone,
	"directus_user_id" uuid,
	"enable_ai_title_and_tags" boolean DEFAULT false,
	"get_reply_mode" varchar(255) DEFAULT 'summarize',
	"get_reply_prompt" text,
	"id" uuid PRIMARY KEY NOT NULL,
	"image_generation_model" varchar(255) DEFAULT 'PLACEHOLDER',
	"is_conversation_allowed" boolean NOT NULL,
	"is_enhanced_audio_processing_enabled" boolean DEFAULT false,
	"is_get_reply_enabled" boolean DEFAULT false,
	"is_project_notification_subscription_allowed" boolean DEFAULT false,
	"is_verify_enabled" boolean DEFAULT false,
	"is_verify_on_finish_enabled" boolean DEFAULT false,
	"language" varchar(255) DEFAULT NULL,
	"name" varchar(255) DEFAULT NULL,
	"pin_order" integer,
	"selected_verification_key_list" text,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"visibility" varchar(255) DEFAULT 'workspace' NOT NULL,
	"workspace_id" uuid,
	"host_guide" json,
	"move_history" json,
	"methodology_version_id" uuid,
	"is_canvas_enabled" boolean DEFAULT false,
	"legal_basis" varchar(255) DEFAULT NULL,
	"privacy_policy_url" varchar(255) DEFAULT NULL,
	"is_dembrane_event_cta_enabled" boolean DEFAULT true
);
--> statement-breakpoint
CREATE TABLE "project_agentic_run" (
	"agent_thread_id" varchar(255) DEFAULT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone,
	"directus_user_id" varchar(255) DEFAULT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"last_event_seq" integer DEFAULT 0,
	"latest_error" text,
	"latest_error_code" varchar(255) DEFAULT NULL,
	"latest_output" text,
	"project_chat_id" uuid,
	"project_id" uuid,
	"started_at" timestamp with time zone,
	"status" varchar(255) DEFAULT 'queued',
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "project_agentic_run_event" (
	"event_type" varchar(255) DEFAULT NULL,
	"id" bigserial PRIMARY KEY NOT NULL,
	"payload" json,
	"project_agentic_run_id" uuid,
	"seq" integer,
	"timestamp" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "project_analysis_run" (
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "project_chat" (
	"auto_select" boolean DEFAULT true,
	"chat_mode" varchar(255) DEFAULT NULL,
	"date_created" timestamp with time zone,
	"date_updated" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(255) DEFAULT NULL,
	"project_id" uuid,
	"user_created" uuid,
	"user_updated" uuid,
	"is_private" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE "project_chat_conversation" (
	"conversation_id" uuid,
	"id" serial PRIMARY KEY NOT NULL,
	"project_chat_id" uuid
);
--> statement-breakpoint
CREATE TABLE "project_chat_message" (
	"date_created" timestamp with time zone,
	"date_updated" timestamp with time zone,
	"id" uuid PRIMARY KEY NOT NULL,
	"message_from" varchar(255) DEFAULT NULL,
	"project_chat_id" uuid,
	"template_key" varchar(255) DEFAULT NULL,
	"text" text,
	"tokens_count" integer
);
--> statement-breakpoint
CREATE TABLE "project_chat_message_conversation" (
	"conversation_id" uuid,
	"id" serial PRIMARY KEY NOT NULL,
	"project_chat_message_id" uuid
);
--> statement-breakpoint
CREATE TABLE "project_chat_message_conversation_1" (
	"conversation_id" uuid,
	"id" serial PRIMARY KEY NOT NULL,
	"project_chat_message_id" uuid
);
--> statement-breakpoint
CREATE TABLE "project_goal_revision" (
	"chat_id" varchar(255) DEFAULT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone,
	"created_by" varchar(255) DEFAULT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid,
	"set_by" varchar(255) DEFAULT NULL NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_membership" (
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"custom_policies" json DEFAULT '[]'::json,
	"granted_by" uuid,
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_report" (
	"content" text,
	"date_created" timestamp with time zone,
	"date_updated" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"error_code" varchar(255) DEFAULT NULL,
	"error_message" text,
	"id" bigserial PRIMARY KEY NOT NULL,
	"language" varchar(255) DEFAULT NULL,
	"project_id" uuid,
	"scheduled_at" timestamp with time zone,
	"show_portal_link" boolean DEFAULT false,
	"status" varchar(255) DEFAULT 'published' NOT NULL,
	"user_instructions" text,
	"user_created" uuid,
	"kind" varchar(255) DEFAULT 'report' NOT NULL,
	"public_token" varchar(255) DEFAULT NULL
);
--> statement-breakpoint
CREATE TABLE "project_report_metric" (
	"date_created" timestamp with time zone,
	"date_updated" timestamp with time zone,
	"id" bigserial PRIMARY KEY NOT NULL,
	"ip" varchar(255) DEFAULT NULL,
	"project_report_id" bigint,
	"type" varchar(255) DEFAULT NULL
);
--> statement-breakpoint
CREATE TABLE "project_report_notification_participants" (
	"conversation_id" uuid,
	"date_submitted" timestamp with time zone,
	"date_updated" timestamp with time zone,
	"email" varchar(255) DEFAULT NULL,
	"email_opt_in" boolean DEFAULT true,
	"email_opt_out_token" uuid,
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" varchar(255) DEFAULT NULL,
	"sort" integer
);
--> statement-breakpoint
CREATE TABLE "project_tag" (
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"sort" integer,
	"text" varchar(255) DEFAULT NULL,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "project_webhook" (
	"date_created" timestamp with time zone,
	"date_updated" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"events" text,
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text,
	"project_id" uuid,
	"secret" varchar(255) DEFAULT NULL,
	"status" varchar(255) DEFAULT 'published' NOT NULL,
	"url" text,
	"user_created" uuid,
	"user_updated" uuid
);
--> statement-breakpoint
CREATE TABLE "prompt_template" (
	"content" text,
	"date_created" timestamp with time zone,
	"date_updated" timestamp with time zone,
	"description" text,
	"icon" varchar(50) DEFAULT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"is_anonymous" boolean,
	"is_public" boolean DEFAULT false,
	"language" varchar(255) DEFAULT NULL,
	"sort" integer,
	"tags" text,
	"title" varchar(200) DEFAULT NULL NOT NULL,
	"user_created" uuid,
	"scope" varchar(255) DEFAULT 'user' NOT NULL,
	"workspace_id" uuid
);
--> statement-breakpoint
CREATE TABLE "recording_overage" (
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
CREATE TABLE "referral_ledger" (
	"created_by_staff_id" uuid,
	"deleted_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"id" serial PRIMARY KEY NOT NULL,
	"notes" text,
	"partner_kickback_percent" integer DEFAULT 20 NOT NULL,
	"partner_team_id" uuid NOT NULL,
	"starts_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"workspace_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_task" (
	"attempts" integer DEFAULT 0,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone,
	"error" text,
	"id" uuid PRIMARY KEY NOT NULL,
	"payload" json,
	"scheduled_at" timestamp with time zone NOT NULL,
	"status" varchar(255) DEFAULT 'scheduled' NOT NULL,
	"task_type" varchar(255) DEFAULT 'revoke_staff_support' NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "support_access_event" (
	"actor_user_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"event_code" varchar(255) DEFAULT NULL NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"params" json,
	"staff_user_id" uuid,
	"workspace_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_access_request" (
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"id" uuid PRIMARY KEY NOT NULL,
	"membership_id" uuid,
	"message" text,
	"requested_by" uuid NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"status" varchar(255) DEFAULT 'pending' NOT NULL,
	"workspace_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_request" (
	"created_at" timestamp with time zone,
	"directus_user_id" varchar(255) DEFAULT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"message" text,
	"page_context" text,
	"project_chat_id" varchar(255) DEFAULT NULL,
	"project_id" varchar(255) DEFAULT NULL,
	"status" varchar(255) DEFAULT 'new',
	"workspace_id" varchar(255) DEFAULT NULL,
	"app_user_id" varchar(255) DEFAULT NULL,
	"chat_id" varchar(255) DEFAULT NULL,
	"message_id" varchar(255) DEFAULT NULL,
	"forwarded_at" timestamp with time zone,
	"source" varchar(255) DEFAULT NULL
);
--> statement-breakpoint
CREATE TABLE "training" (
	"base_price_eur" real,
	"created_at" timestamp with time zone,
	"extra_participants" integer DEFAULT 0,
	"extra_price_eur" real,
	"grants_license" boolean DEFAULT true NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"included_participants" integer DEFAULT 0,
	"notes" text,
	"org_id" uuid,
	"requested_by" uuid,
	"scheduled_at" timestamp with time zone,
	"status" varchar(255) DEFAULT 'requested',
	"type" varchar(255) DEFAULT 'online',
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "training_license" (
	"app_user_id" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"granted_by" uuid,
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid,
	"status" varchar(255) DEFAULT 'active',
	"training_id" uuid
);
--> statement-breakpoint
CREATE TABLE "usage_insight" (
	"created_at" timestamp with time zone,
	"directus_user_id" varchar(255) DEFAULT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"insight_type" varchar(255) DEFAULT 'intent',
	"project_chat_id" varchar(255) DEFAULT NULL,
	"project_id" varchar(255) DEFAULT NULL,
	"status" varchar(255) DEFAULT 'new',
	"summary" text,
	"workspace_id" varchar(255) DEFAULT NULL,
	"app_user_id" varchar(255) DEFAULT NULL,
	"chat_id" varchar(255) DEFAULT NULL,
	"message_id" varchar(255) DEFAULT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_topic" (
	"date_created" timestamp with time zone,
	"date_updated" timestamp with time zone,
	"icon" varchar(255) DEFAULT NULL,
	"key" varchar(255) PRIMARY KEY DEFAULT NULL NOT NULL,
	"project_id" uuid,
	"prompt" text,
	"sort" integer,
	"user_created" uuid,
	"user_updated" uuid
);
--> statement-breakpoint
CREATE TABLE "verification_topic_translations" (
	"id" serial PRIMARY KEY NOT NULL,
	"label" varchar(255) DEFAULT NULL,
	"languages_code" varchar(255) DEFAULT NULL,
	"verification_topic_key" varchar(255) DEFAULT NULL
);
--> statement-breakpoint
CREATE TABLE "view" (
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"description" text,
	"id" uuid PRIMARY KEY NOT NULL,
	"language" varchar(255) DEFAULT NULL,
	"name" varchar(255) DEFAULT NULL,
	"project_analysis_run_id" uuid,
	"summary" text,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"user_input" text,
	"user_input_description" text
);
--> statement-breakpoint
CREATE TABLE "workspace" (
	"billed_to_team_id" uuid,
	"billed_to_workspace_id" uuid,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"created_by" uuid,
	"deleted_at" timestamp with time zone,
	"description" text,
	"effective_client_team_id" uuid,
	"handoff_status" varchar(255) DEFAULT NULL,
	"handoff_target_team_id" uuid,
	"id" uuid PRIMARY KEY NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"legal_basis" varchar(255) DEFAULT NULL,
	"logo_url" varchar(255) DEFAULT NULL,
	"name" varchar(255) DEFAULT NULL NOT NULL,
	"org_id" uuid NOT NULL,
	"privacy_policy_url" varchar(255) DEFAULT NULL,
	"settings" json DEFAULT '{}'::json,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"visibility" varchar(255) DEFAULT 'open_to_organisation',
	"billing_account_id" uuid NOT NULL,
	"usage_context" varchar(255) DEFAULT NULL,
	"data_owner_email" varchar(255) DEFAULT NULL,
	"data_owner_org_name" varchar(255) DEFAULT NULL,
	"partner_agreement_accepted_at" timestamp with time zone,
	"allow_support_access" boolean DEFAULT false NOT NULL,
	"context" text
);
--> statement-breakpoint
CREATE TABLE "workspace_invite" (
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"email" varchar(255) DEFAULT NULL NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"invited_by" uuid,
	"role" varchar(255) DEFAULT NULL NOT NULL,
	"workspace_id" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	"project_id" uuid
);
--> statement-breakpoint
CREATE TABLE "workspace_membership" (
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"custom_policies" json DEFAULT '[]'::json,
	"deleted_at" timestamp with time zone,
	"id" uuid PRIMARY KEY NOT NULL,
	"role" varchar(255) DEFAULT NULL NOT NULL,
	"source" varchar(255) DEFAULT 'direct' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workspace_request" (
	"approved_billing_period" varchar(255) DEFAULT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"denial_reason" text,
	"granted_percent_discount" integer,
	"granted_tier" varchar(255) DEFAULT NULL,
	"granted_tier_expires_at" timestamp with time zone,
	"granted_type_discount" varchar(255) DEFAULT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" varchar(255) DEFAULT NULL NOT NULL,
	"org_id" uuid NOT NULL,
	"proposed_billing_period" varchar(255) DEFAULT NULL,
	"proposed_name" varchar(100) DEFAULT NULL,
	"proposed_tier" varchar(255) DEFAULT 'innovator' NOT NULL,
	"proposed_visibility" varchar(255) DEFAULT 'open_to_organisation' NOT NULL,
	"requested_by" uuid NOT NULL,
	"requester_message" text,
	"resulting_workspace_id" uuid,
	"staff_notes" text,
	"status" varchar(255) DEFAULT 'pending' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"workspace_id" uuid
);
--> statement-breakpoint
ALTER TABLE "access_request" ADD CONSTRAINT "access_request_actioned_by_foreign" FOREIGN KEY ("actioned_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_request" ADD CONSTRAINT "access_request_user_id_foreign" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_request" ADD CONSTRAINT "access_request_workspace_id_foreign" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_loop" ADD CONSTRAINT "agent_loop_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_loop" ADD CONSTRAINT "agent_loop_report_id_foreign" FOREIGN KEY ("report_id") REFERENCES "public"."project_report"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_loop_run" ADD CONSTRAINT "agent_loop_run_generation_id_foreign" FOREIGN KEY ("generation_id") REFERENCES "public"."canvas_generation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_loop_run" ADD CONSTRAINT "agent_loop_run_loop_id_foreign" FOREIGN KEY ("loop_id") REFERENCES "public"."agent_loop"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_feedback" ADD CONSTRAINT "analysis_feedback_object_id_foreign" FOREIGN KEY ("object_id") REFERENCES "public"."analysis_object"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_feedback" ADD CONSTRAINT "analysis_feedback_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_feedback" ADD CONSTRAINT "analysis_feedback_revision_id_foreign" FOREIGN KEY ("revision_id") REFERENCES "public"."analysis_object_revision"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_last_opened" ADD CONSTRAINT "analysis_last_opened_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_object" ADD CONSTRAINT "analysis_object_current_revision_id_foreign" FOREIGN KEY ("current_revision_id") REFERENCES "public"."analysis_object_revision"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_object" ADD CONSTRAINT "analysis_object_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_object" ADD CONSTRAINT "analysis_object_scope_id_foreign" FOREIGN KEY ("scope_id") REFERENCES "public"."analysis_scope"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_object_revision" ADD CONSTRAINT "analysis_object_revision_object_id_foreign" FOREIGN KEY ("object_id") REFERENCES "public"."analysis_object"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_object_revision" ADD CONSTRAINT "analysis_object_revision_parent_revision_id_foreign" FOREIGN KEY ("parent_revision_id") REFERENCES "public"."analysis_object_revision"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_object_revision" ADD CONSTRAINT "analysis_object_revision_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_object_revision" ADD CONSTRAINT "analysis_object_revision_run_id_foreign" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_outbox" ADD CONSTRAINT "analysis_outbox_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_outbox" ADD CONSTRAINT "analysis_outbox_run_id_foreign" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_outbox" ADD CONSTRAINT "analysis_outbox_scope_id_foreign" FOREIGN KEY ("scope_id") REFERENCES "public"."analysis_scope"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_outbox" ADD CONSTRAINT "analysis_outbox_snapshot_id_foreign" FOREIGN KEY ("snapshot_id") REFERENCES "public"."analysis_snapshot"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_relation" ADD CONSTRAINT "analysis_relation_from_object_id_foreign" FOREIGN KEY ("from_object_id") REFERENCES "public"."analysis_object"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_relation" ADD CONSTRAINT "analysis_relation_from_revision_id_foreign" FOREIGN KEY ("from_revision_id") REFERENCES "public"."analysis_object_revision"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_relation" ADD CONSTRAINT "analysis_relation_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_relation" ADD CONSTRAINT "analysis_relation_run_id_foreign" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_relation" ADD CONSTRAINT "analysis_relation_to_object_id_foreign" FOREIGN KEY ("to_object_id") REFERENCES "public"."analysis_object"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_relation" ADD CONSTRAINT "analysis_relation_to_revision_id_foreign" FOREIGN KEY ("to_revision_id") REFERENCES "public"."analysis_object_revision"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_request_key" ADD CONSTRAINT "analysis_request_key_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_request_key" ADD CONSTRAINT "analysis_request_key_run_id_foreign" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_request_key" ADD CONSTRAINT "analysis_request_key_scope_id_foreign" FOREIGN KEY ("scope_id") REFERENCES "public"."analysis_scope"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_run" ADD CONSTRAINT "analysis_run_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_run" ADD CONSTRAINT "analysis_run_reused_run_id_foreign" FOREIGN KEY ("reused_run_id") REFERENCES "public"."analysis_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_run" ADD CONSTRAINT "analysis_run_scope_id_foreign" FOREIGN KEY ("scope_id") REFERENCES "public"."analysis_scope"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_scope" ADD CONSTRAINT "analysis_scope_current_run_id_foreign" FOREIGN KEY ("current_run_id") REFERENCES "public"."analysis_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_scope" ADD CONSTRAINT "analysis_scope_current_snapshot_id_foreign" FOREIGN KEY ("current_snapshot_id") REFERENCES "public"."analysis_snapshot"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_scope" ADD CONSTRAINT "analysis_scope_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_snapshot" ADD CONSTRAINT "analysis_snapshot_parent_snapshot_id_foreign" FOREIGN KEY ("parent_snapshot_id") REFERENCES "public"."analysis_snapshot"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_snapshot" ADD CONSTRAINT "analysis_snapshot_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_snapshot" ADD CONSTRAINT "analysis_snapshot_scope_id_foreign" FOREIGN KEY ("scope_id") REFERENCES "public"."analysis_scope"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_step" ADD CONSTRAINT "analysis_step_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_step" ADD CONSTRAINT "analysis_step_reused_step_id_foreign" FOREIGN KEY ("reused_step_id") REFERENCES "public"."analysis_step"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_step" ADD CONSTRAINT "analysis_step_run_id_foreign" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement" ADD CONSTRAINT "announcement_user_created_foreign" FOREIGN KEY ("user_created") REFERENCES "public"."directus_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement" ADD CONSTRAINT "announcement_user_updated_foreign" FOREIGN KEY ("user_updated") REFERENCES "public"."directus_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_activity" ADD CONSTRAINT "announcement_activity_announcement_activity_foreign" FOREIGN KEY ("announcement_activity") REFERENCES "public"."announcement"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_activity" ADD CONSTRAINT "announcement_activity_user_created_foreign" FOREIGN KEY ("user_created") REFERENCES "public"."directus_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_activity" ADD CONSTRAINT "announcement_activity_user_updated_foreign" FOREIGN KEY ("user_updated") REFERENCES "public"."directus_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_translations" ADD CONSTRAINT "announcement_translations_announcement_id_foreign" FOREIGN KEY ("announcement_id") REFERENCES "public"."announcement"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_translations" ADD CONSTRAINT "announcement_translations_languages_code_foreign" FOREIGN KEY ("languages_code") REFERENCES "public"."languages"("code") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aspect" ADD CONSTRAINT "aspect_view_id_foreign" FOREIGN KEY ("view_id") REFERENCES "public"."view"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aspect_segment" ADD CONSTRAINT "aspect_segment_aspect_foreign" FOREIGN KEY ("aspect") REFERENCES "public"."aspect"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aspect_segment" ADD CONSTRAINT "aspect_segment_segment_foreign" FOREIGN KEY ("segment") REFERENCES "public"."conversation_segment"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_account" ADD CONSTRAINT "billing_account_account_manager_id_foreign" FOREIGN KEY ("account_manager_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_account" ADD CONSTRAINT "billing_account_created_by_foreign" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_account" ADD CONSTRAINT "billing_account_org_id_foreign" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_account" ADD CONSTRAINT "billing_account_workspace_id_foreign" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_config_revision" ADD CONSTRAINT "canvas_config_revision_report_id_foreign" FOREIGN KEY ("report_id") REFERENCES "public"."project_report"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_generation" ADD CONSTRAINT "canvas_generation_config_revision_id_foreign" FOREIGN KEY ("config_revision_id") REFERENCES "public"."canvas_config_revision"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_generation" ADD CONSTRAINT "canvas_generation_report_id_foreign" FOREIGN KEY ("report_id") REFERENCES "public"."project_report"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_artifact" ADD CONSTRAINT "conversation_artifact_conversation_id_foreign" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_artifact" ADD CONSTRAINT "conversation_artifact_user_created_foreign" FOREIGN KEY ("user_created") REFERENCES "public"."directus_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_artifact" ADD CONSTRAINT "conversation_artifact_user_updated_foreign" FOREIGN KEY ("user_updated") REFERENCES "public"."directus_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_chunk" ADD CONSTRAINT "conversation_chunk_conversation_id_foreign" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_link" ADD CONSTRAINT "conversation_link_source_conversation_id_foreign" FOREIGN KEY ("source_conversation_id") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_link" ADD CONSTRAINT "conversation_link_target_conversation_id_foreign" FOREIGN KEY ("target_conversation_id") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_project_tag" ADD CONSTRAINT "conversation_project_tag_conversation_id_foreign" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_project_tag" ADD CONSTRAINT "conversation_project_tag_project_tag_id_foreign" FOREIGN KEY ("project_tag_id") REFERENCES "public"."project_tag"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_reply" ADD CONSTRAINT "conversation_reply_reply_foreign" FOREIGN KEY ("reply") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_segment" ADD CONSTRAINT "conversation_segment_conversation_id_foreign" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_segment_conversation_chunk" ADD CONSTRAINT "conversation_segment_conversation_chunk_co__1f8deab8_foreign" FOREIGN KEY ("conversation_chunk_id") REFERENCES "public"."conversation_chunk"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_segment_conversation_chunk" ADD CONSTRAINT "conversation_segment_conversation_chunk_co__4f4b4f4e_foreign" FOREIGN KEY ("conversation_segment_id") REFERENCES "public"."conversation_segment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_access" ADD CONSTRAINT "directus_access_policy_foreign" FOREIGN KEY ("policy") REFERENCES "public"."directus_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_access" ADD CONSTRAINT "directus_access_role_foreign" FOREIGN KEY ("role") REFERENCES "public"."directus_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_access" ADD CONSTRAINT "directus_access_user_foreign" FOREIGN KEY ("user") REFERENCES "public"."directus_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_collections" ADD CONSTRAINT "directus_collections_group_foreign" FOREIGN KEY ("group") REFERENCES "public"."directus_collections"("collection") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_comments" ADD CONSTRAINT "directus_comments_user_created_foreign" FOREIGN KEY ("user_created") REFERENCES "public"."directus_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_comments" ADD CONSTRAINT "directus_comments_user_updated_foreign" FOREIGN KEY ("user_updated") REFERENCES "public"."directus_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_dashboards" ADD CONSTRAINT "directus_dashboards_user_created_foreign" FOREIGN KEY ("user_created") REFERENCES "public"."directus_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_files" ADD CONSTRAINT "directus_files_folder_foreign" FOREIGN KEY ("folder") REFERENCES "public"."directus_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_files" ADD CONSTRAINT "directus_files_modified_by_foreign" FOREIGN KEY ("modified_by") REFERENCES "public"."directus_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_files" ADD CONSTRAINT "directus_files_uploaded_by_foreign" FOREIGN KEY ("uploaded_by") REFERENCES "public"."directus_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_flows" ADD CONSTRAINT "directus_flows_user_created_foreign" FOREIGN KEY ("user_created") REFERENCES "public"."directus_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_folders" ADD CONSTRAINT "directus_folders_parent_foreign" FOREIGN KEY ("parent") REFERENCES "public"."directus_folders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_notifications" ADD CONSTRAINT "directus_notifications_recipient_foreign" FOREIGN KEY ("recipient") REFERENCES "public"."directus_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_notifications" ADD CONSTRAINT "directus_notifications_sender_foreign" FOREIGN KEY ("sender") REFERENCES "public"."directus_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_operations" ADD CONSTRAINT "directus_operations_flow_foreign" FOREIGN KEY ("flow") REFERENCES "public"."directus_flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_operations" ADD CONSTRAINT "directus_operations_reject_foreign" FOREIGN KEY ("reject") REFERENCES "public"."directus_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_operations" ADD CONSTRAINT "directus_operations_resolve_foreign" FOREIGN KEY ("resolve") REFERENCES "public"."directus_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_operations" ADD CONSTRAINT "directus_operations_user_created_foreign" FOREIGN KEY ("user_created") REFERENCES "public"."directus_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_panels" ADD CONSTRAINT "directus_panels_dashboard_foreign" FOREIGN KEY ("dashboard") REFERENCES "public"."directus_dashboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_panels" ADD CONSTRAINT "directus_panels_user_created_foreign" FOREIGN KEY ("user_created") REFERENCES "public"."directus_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_permissions" ADD CONSTRAINT "directus_permissions_policy_foreign" FOREIGN KEY ("policy") REFERENCES "public"."directus_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_presets" ADD CONSTRAINT "directus_presets_role_foreign" FOREIGN KEY ("role") REFERENCES "public"."directus_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_presets" ADD CONSTRAINT "directus_presets_user_foreign" FOREIGN KEY ("user") REFERENCES "public"."directus_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_revisions" ADD CONSTRAINT "directus_revisions_activity_foreign" FOREIGN KEY ("activity") REFERENCES "public"."directus_activity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_revisions" ADD CONSTRAINT "directus_revisions_parent_foreign" FOREIGN KEY ("parent") REFERENCES "public"."directus_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_revisions" ADD CONSTRAINT "directus_revisions_version_foreign" FOREIGN KEY ("version") REFERENCES "public"."directus_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_roles" ADD CONSTRAINT "directus_roles_parent_foreign" FOREIGN KEY ("parent") REFERENCES "public"."directus_roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_sessions" ADD CONSTRAINT "directus_sessions_share_foreign" FOREIGN KEY ("share") REFERENCES "public"."directus_shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_sessions" ADD CONSTRAINT "directus_sessions_user_foreign" FOREIGN KEY ("user") REFERENCES "public"."directus_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_settings" ADD CONSTRAINT "directus_settings_project_logo_foreign" FOREIGN KEY ("project_logo") REFERENCES "public"."directus_files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_settings" ADD CONSTRAINT "directus_settings_public_background_foreign" FOREIGN KEY ("public_background") REFERENCES "public"."directus_files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_settings" ADD CONSTRAINT "directus_settings_public_favicon_foreign" FOREIGN KEY ("public_favicon") REFERENCES "public"."directus_files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_settings" ADD CONSTRAINT "directus_settings_public_foreground_foreign" FOREIGN KEY ("public_foreground") REFERENCES "public"."directus_files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_settings" ADD CONSTRAINT "directus_settings_public_registration_role_foreign" FOREIGN KEY ("public_registration_role") REFERENCES "public"."directus_roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_settings" ADD CONSTRAINT "directus_settings_storage_default_folder_foreign" FOREIGN KEY ("storage_default_folder") REFERENCES "public"."directus_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_shares" ADD CONSTRAINT "directus_shares_collection_foreign" FOREIGN KEY ("collection") REFERENCES "public"."directus_collections"("collection") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_shares" ADD CONSTRAINT "directus_shares_role_foreign" FOREIGN KEY ("role") REFERENCES "public"."directus_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_shares" ADD CONSTRAINT "directus_shares_user_created_foreign" FOREIGN KEY ("user_created") REFERENCES "public"."directus_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_users" ADD CONSTRAINT "directus_users_role_foreign" FOREIGN KEY ("role") REFERENCES "public"."directus_roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_users" ADD CONSTRAINT "directus_users_whitelabel_logo_foreign" FOREIGN KEY ("whitelabel_logo") REFERENCES "public"."directus_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_versions" ADD CONSTRAINT "directus_versions_collection_foreign" FOREIGN KEY ("collection") REFERENCES "public"."directus_collections"("collection") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_versions" ADD CONSTRAINT "directus_versions_user_created_foreign" FOREIGN KEY ("user_created") REFERENCES "public"."directus_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_versions" ADD CONSTRAINT "directus_versions_user_updated_foreign" FOREIGN KEY ("user_updated") REFERENCES "public"."directus_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directus_webhooks" ADD CONSTRAINT "directus_webhooks_migrated_flow_foreign" FOREIGN KEY ("migrated_flow") REFERENCES "public"."directus_flows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insight" ADD CONSTRAINT "insight_project_analysis_run_id_foreign" FOREIGN KEY ("project_analysis_run_id") REFERENCES "public"."project_analysis_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "map_embedding" ADD CONSTRAINT "map_embedding_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "map_fact_check" ADD CONSTRAINT "map_fact_check_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "map_result" ADD CONSTRAINT "map_result_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "map_result" ADD CONSTRAINT "map_result_snapshot_id_foreign" FOREIGN KEY ("snapshot_id") REFERENCES "public"."analysis_snapshot"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "methodology" ADD CONSTRAINT "methodology_workspace_id_foreign" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "methodology_version" ADD CONSTRAINT "methodology_version_methodology_id_foreign" FOREIGN KEY ("methodology_id") REFERENCES "public"."methodology"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_response_feedback" ADD CONSTRAINT "model_response_feedback_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_response_feedback" ADD CONSTRAINT "model_response_feedback_user_id_foreign" FOREIGN KEY ("user_id") REFERENCES "public"."directus_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_actor_user_id_foreign" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_audience_user_id_foreign" FOREIGN KEY ("audience_user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_ref_chat_id_foreign" FOREIGN KEY ("ref_chat_id") REFERENCES "public"."project_chat"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_ref_conversation_id_foreign" FOREIGN KEY ("ref_conversation_id") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_ref_invite_id_foreign" FOREIGN KEY ("ref_invite_id") REFERENCES "public"."workspace_invite"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_ref_org_id_foreign" FOREIGN KEY ("ref_org_id") REFERENCES "public"."org"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_ref_project_id_foreign" FOREIGN KEY ("ref_project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_ref_workspace_id_foreign" FOREIGN KEY ("ref_workspace_id") REFERENCES "public"."workspace"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org" ADD CONSTRAINT "org_created_by_foreign" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invite" ADD CONSTRAINT "org_invite_invited_by_foreign" FOREIGN KEY ("invited_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invite" ADD CONSTRAINT "org_invite_org_id_foreign" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_membership" ADD CONSTRAINT "org_membership_org_id_foreign" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_membership" ADD CONSTRAINT "org_membership_user_id_foreign" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_status" ADD CONSTRAINT "processing_status_conversation_chunk_id_foreign" FOREIGN KEY ("conversation_chunk_id") REFERENCES "public"."conversation_chunk"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_status" ADD CONSTRAINT "processing_status_conversation_id_foreign" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_status" ADD CONSTRAINT "processing_status_parent_foreign" FOREIGN KEY ("parent") REFERENCES "public"."processing_status"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_status" ADD CONSTRAINT "processing_status_project_analysis_run_id_foreign" FOREIGN KEY ("project_analysis_run_id") REFERENCES "public"."project_analysis_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_status" ADD CONSTRAINT "processing_status_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_directus_user_id_foreign" FOREIGN KEY ("directus_user_id") REFERENCES "public"."directus_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_methodology_version_id_foreign" FOREIGN KEY ("methodology_version_id") REFERENCES "public"."methodology_version"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_workspace_id_foreign" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_agentic_run" ADD CONSTRAINT "project_agentic_run_project_chat_id_foreign" FOREIGN KEY ("project_chat_id") REFERENCES "public"."project_chat"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_agentic_run" ADD CONSTRAINT "project_agentic_run_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_agentic_run_event" ADD CONSTRAINT "project_agentic_run_event_project_agentic_run_id_foreign" FOREIGN KEY ("project_agentic_run_id") REFERENCES "public"."project_agentic_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_analysis_run" ADD CONSTRAINT "project_analysis_run_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_chat" ADD CONSTRAINT "project_chat_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_chat" ADD CONSTRAINT "project_chat_user_created_foreign" FOREIGN KEY ("user_created") REFERENCES "public"."directus_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_chat" ADD CONSTRAINT "project_chat_user_updated_foreign" FOREIGN KEY ("user_updated") REFERENCES "public"."directus_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_chat_conversation" ADD CONSTRAINT "project_chat_conversation_conversation_id_foreign" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_chat_conversation" ADD CONSTRAINT "project_chat_conversation_project_chat_id_foreign" FOREIGN KEY ("project_chat_id") REFERENCES "public"."project_chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_chat_message" ADD CONSTRAINT "project_chat_message_project_chat_id_foreign" FOREIGN KEY ("project_chat_id") REFERENCES "public"."project_chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_chat_message_conversation" ADD CONSTRAINT "project_chat_message_conversation_conversation_id_foreign" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_chat_message_conversation" ADD CONSTRAINT "project_chat_message_conversation_project___3af13f9a_foreign" FOREIGN KEY ("project_chat_message_id") REFERENCES "public"."project_chat_message"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_chat_message_conversation_1" ADD CONSTRAINT "project_chat_message_conversation_1_conversation_id_foreign" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_chat_message_conversation_1" ADD CONSTRAINT "project_chat_message_conversation_1_projec__225db2e8_foreign" FOREIGN KEY ("project_chat_message_id") REFERENCES "public"."project_chat_message"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_goal_revision" ADD CONSTRAINT "project_goal_revision_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_membership" ADD CONSTRAINT "project_membership_granted_by_foreign" FOREIGN KEY ("granted_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_membership" ADD CONSTRAINT "project_membership_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_membership" ADD CONSTRAINT "project_membership_user_id_foreign" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_report" ADD CONSTRAINT "project_report_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_report" ADD CONSTRAINT "project_report_user_created_foreign" FOREIGN KEY ("user_created") REFERENCES "public"."directus_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_report_metric" ADD CONSTRAINT "project_report_metric_project_report_id_foreign" FOREIGN KEY ("project_report_id") REFERENCES "public"."project_report"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_report_notification_participants" ADD CONSTRAINT "project_report_notification_participants_c__5f83ce3c_foreign" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tag" ADD CONSTRAINT "project_tag_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_webhook" ADD CONSTRAINT "project_webhook_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_webhook" ADD CONSTRAINT "project_webhook_user_created_foreign" FOREIGN KEY ("user_created") REFERENCES "public"."directus_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_webhook" ADD CONSTRAINT "project_webhook_user_updated_foreign" FOREIGN KEY ("user_updated") REFERENCES "public"."directus_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_template" ADD CONSTRAINT "prompt_template_user_created_foreign" FOREIGN KEY ("user_created") REFERENCES "public"."directus_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_template" ADD CONSTRAINT "prompt_template_workspace_id_foreign" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_overage" ADD CONSTRAINT "recording_overage_billing_account_id_foreign" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_ledger" ADD CONSTRAINT "referral_ledger_created_by_staff_id_foreign" FOREIGN KEY ("created_by_staff_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_ledger" ADD CONSTRAINT "referral_ledger_partner_team_id_foreign" FOREIGN KEY ("partner_team_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_ledger" ADD CONSTRAINT "referral_ledger_workspace_id_foreign" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_event" ADD CONSTRAINT "support_access_event_actor_user_id_foreign" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_event" ADD CONSTRAINT "support_access_event_staff_user_id_foreign" FOREIGN KEY ("staff_user_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_event" ADD CONSTRAINT "support_access_event_workspace_id_foreign" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_request" ADD CONSTRAINT "support_access_request_membership_id_foreign" FOREIGN KEY ("membership_id") REFERENCES "public"."workspace_membership"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_request" ADD CONSTRAINT "support_access_request_requested_by_foreign" FOREIGN KEY ("requested_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_request" ADD CONSTRAINT "support_access_request_resolved_by_foreign" FOREIGN KEY ("resolved_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_request" ADD CONSTRAINT "support_access_request_workspace_id_foreign" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training" ADD CONSTRAINT "training_org_id_foreign" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training" ADD CONSTRAINT "training_requested_by_foreign" FOREIGN KEY ("requested_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_license" ADD CONSTRAINT "training_license_app_user_id_foreign" FOREIGN KEY ("app_user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_license" ADD CONSTRAINT "training_license_granted_by_foreign" FOREIGN KEY ("granted_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_license" ADD CONSTRAINT "training_license_org_id_foreign" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_license" ADD CONSTRAINT "training_license_training_id_foreign" FOREIGN KEY ("training_id") REFERENCES "public"."training"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_topic" ADD CONSTRAINT "verification_topic_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_topic" ADD CONSTRAINT "verification_topic_user_created_foreign" FOREIGN KEY ("user_created") REFERENCES "public"."directus_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_topic" ADD CONSTRAINT "verification_topic_user_updated_foreign" FOREIGN KEY ("user_updated") REFERENCES "public"."directus_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_topic_translations" ADD CONSTRAINT "verification_topic_translations_languages_code_foreign" FOREIGN KEY ("languages_code") REFERENCES "public"."languages"("code") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_topic_translations" ADD CONSTRAINT "verification_topic_translations_verificati__34868e89_foreign" FOREIGN KEY ("verification_topic_key") REFERENCES "public"."verification_topic"("key") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "view" ADD CONSTRAINT "view_project_analysis_run_id_foreign" FOREIGN KEY ("project_analysis_run_id") REFERENCES "public"."project_analysis_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_billed_to_team_id_foreign" FOREIGN KEY ("billed_to_team_id") REFERENCES "public"."org"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_billed_to_workspace_id_foreign" FOREIGN KEY ("billed_to_workspace_id") REFERENCES "public"."workspace"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_billing_account_id_foreign" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_created_by_foreign" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_effective_client_team_id_foreign" FOREIGN KEY ("effective_client_team_id") REFERENCES "public"."org"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_handoff_target_team_id_foreign" FOREIGN KEY ("handoff_target_team_id") REFERENCES "public"."org"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_org_id_foreign" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invite" ADD CONSTRAINT "workspace_invite_invited_by_foreign" FOREIGN KEY ("invited_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invite" ADD CONSTRAINT "workspace_invite_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invite" ADD CONSTRAINT "workspace_invite_workspace_id_foreign" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_membership" ADD CONSTRAINT "workspace_membership_user_id_foreign" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_membership" ADD CONSTRAINT "workspace_membership_workspace_id_foreign" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_request" ADD CONSTRAINT "workspace_request_decided_by_foreign" FOREIGN KEY ("decided_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_request" ADD CONSTRAINT "workspace_request_org_id_foreign" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_request" ADD CONSTRAINT "workspace_request_requested_by_foreign" FOREIGN KEY ("requested_by") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_request" ADD CONSTRAINT "workspace_request_resulting_workspace_id_foreign" FOREIGN KEY ("resulting_workspace_id") REFERENCES "public"."workspace"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_request" ADD CONSTRAINT "workspace_request_workspace_id_foreign" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_audit_event_app_user_id_index" ON "agent_audit_event" USING btree ("app_user_id");--> statement-breakpoint
CREATE INDEX "agent_audit_event_client_id_index" ON "agent_audit_event" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "agent_audit_event_created_at_index" ON "agent_audit_event" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "agent_audit_event_grant_id_index" ON "agent_audit_event" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "agent_audit_event_org_id_index" ON "agent_audit_event" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "agent_audit_event_tool_index" ON "agent_audit_event" USING btree ("tool");--> statement-breakpoint
CREATE INDEX "agent_grant_app_user_id_index" ON "agent_grant" USING btree ("app_user_id");--> statement-breakpoint
CREATE INDEX "agent_grant_client_id_index" ON "agent_grant" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "agent_grant_directus_user_id_index" ON "agent_grant" USING btree ("directus_user_id");--> statement-breakpoint
CREATE INDEX "agent_grant_expires_at_index" ON "agent_grant" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "agent_grant_revoked_at_index" ON "agent_grant" USING btree ("revoked_at");--> statement-breakpoint
CREATE INDEX "agent_token_expires_at_index" ON "agent_token" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "agent_token_grant_id_index" ON "agent_token" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "agent_token_pair_id_index" ON "agent_token" USING btree ("pair_id");--> statement-breakpoint
CREATE INDEX "agent_token_revoked_at_index" ON "agent_token" USING btree ("revoked_at");--> statement-breakpoint
CREATE INDEX "agent_token_token_hash_index" ON "agent_token" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_feedback_project_object_actor" ON "analysis_feedback" USING btree ("project_id","object_id","actor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_last_opened_project_user" ON "analysis_last_opened" USING btree ("project_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_object_project_lineage" ON "analysis_object" USING btree ("project_id","type","lineage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_object_revision_object_number" ON "analysis_object_revision" USING btree ("object_id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_object_revision_one_staged_per_run" ON "analysis_object_revision" USING btree ("run_id","object_id") WHERE ((status)::text = ANY (ARRAY[('staged'::character varying)::text, ('candidate'::character varying)::text]));--> statement-breakpoint
CREATE INDEX "analysis_object_revision_run_status" ON "analysis_object_revision" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX "analysis_outbox_due" ON "analysis_outbox" USING btree ("next_attempt_at","created_at") WHERE ((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('dispatching'::character varying)::text]));--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_outbox_scope_sequence" ON "analysis_outbox" USING btree ("scope_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_relation_one_staged_per_run" ON "analysis_relation" USING btree ("run_id","type","from_revision_id","to_revision_id") WHERE ((status)::text = 'staged'::text);--> statement-breakpoint
CREATE INDEX "analysis_relation_published_from" ON "analysis_relation" USING btree ("from_revision_id","type") WHERE ((status)::text = 'published'::text);--> statement-breakpoint
CREATE INDEX "analysis_relation_published_to" ON "analysis_relation" USING btree ("to_revision_id","type") WHERE ((status)::text = 'published'::text);--> statement-breakpoint
CREATE INDEX "analysis_relation_run_status" ON "analysis_relation" USING btree ("run_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_request_key_project_key" ON "analysis_request_key" USING btree ("project_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "analysis_request_key_run" ON "analysis_request_key" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_run_one_active_request" ON "analysis_run" USING btree ("scope_id","request_fingerprint") WHERE ((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('waiting_for_inputs'::character varying)::text, ('running'::character varying)::text]));--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_run_project_idempotency" ON "analysis_run" USING btree ("project_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "analysis_run_running_expiry" ON "analysis_run" USING btree ("lease_expires_at","id") WHERE ((status)::text = 'running'::text);--> statement-breakpoint
CREATE INDEX "analysis_run_running_lease" ON "analysis_run" USING btree ("recipe_id","lease_expires_at") WHERE ((status)::text = 'running'::text);--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_run_scope_request_order" ON "analysis_run" USING btree ("scope_id","request_order");--> statement-breakpoint
CREATE INDEX "analysis_run_scope_status_created" ON "analysis_run" USING btree ("scope_id","status","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "analysis_run_waiting_by_project" ON "analysis_run" USING btree ("project_id","created_at") WHERE ((status)::text = 'waiting_for_inputs'::text);--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_scope_producer_identity" ON "analysis_scope" USING btree ("project_id","recipe_id","scope_key") WHERE ((kind)::text = 'producer'::text);--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_scope_view_identity" ON "analysis_scope" USING btree ("project_id","view_id","scope_key") WHERE ((kind)::text = 'view'::text);--> statement-breakpoint
CREATE INDEX "analysis_snapshot_scope_created" ON "analysis_snapshot" USING btree ("scope_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_snapshot_scope_source_event" ON "analysis_snapshot" USING btree ("scope_id","source_event_id") WHERE (source_event_id IS NOT NULL);--> statement-breakpoint
CREATE INDEX "analysis_step_project_cache" ON "analysis_step" USING btree ("project_id","cache_key","completed_at" DESC NULLS FIRST) WHERE (((status)::text = 'completed'::text) AND (reused_step_id IS NULL));--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_step_run_step" ON "analysis_step" USING btree ("run_id","step_key");--> statement-breakpoint
CREATE INDEX "conversation_chunk_timestamp_index" ON "conversation_chunk" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "conversation_link_source_conversation_id_index" ON "conversation_link" USING btree ("source_conversation_id");--> statement-breakpoint
CREATE INDEX "conversation_link_target_conversation_id_index" ON "conversation_link" USING btree ("target_conversation_id");--> statement-breakpoint
CREATE INDEX "directus_sync_id_map_created_at_index" ON "directus_sync_id_map" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "map_embedding_project_input_config" ON "map_embedding" USING btree ("project_id","input_hash","config_key");--> statement-breakpoint
CREATE UNIQUE INDEX "map_fact_check_project_claim" ON "map_fact_check" USING btree ("project_id","claim_key");--> statement-breakpoint
CREATE UNIQUE INDEX "map_result_one_active_attempt" ON "map_result" USING btree ("project_id") WHERE ((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('extracting'::character varying)::text, ('embedding'::character varying)::text]));--> statement-breakpoint
CREATE INDEX "map_result_project_status_created" ON "map_result" USING btree ("project_id","status","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "org_invite_accepted_at_index" ON "org_invite" USING btree ("accepted_at");--> statement-breakpoint
CREATE INDEX "org_invite_deleted_at_index" ON "org_invite" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "org_invite_email_index" ON "org_invite" USING btree ("email");--> statement-breakpoint
CREATE INDEX "processing_status_conversation_chunk_id_index" ON "processing_status" USING btree ("conversation_chunk_id");--> statement-breakpoint
CREATE INDEX "processing_status_conversation_id_index" ON "processing_status" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "processing_status_project_id_index" ON "processing_status" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "scheduled_task_scheduled_at_index" ON "scheduled_task" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "scheduled_task_status_index" ON "scheduled_task" USING btree ("status");--> statement-breakpoint
CREATE INDEX "support_access_event_created_at_index" ON "support_access_event" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "support_access_event_event_code_index" ON "support_access_event" USING btree ("event_code");--> statement-breakpoint
CREATE INDEX "support_access_request_status_index" ON "support_access_request" USING btree ("status");--> statement-breakpoint
CREATE INDEX "workspace_invite_deleted_at_index" ON "workspace_invite" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "workspace_membership_expires_at_index" ON "workspace_membership" USING btree ("expires_at");