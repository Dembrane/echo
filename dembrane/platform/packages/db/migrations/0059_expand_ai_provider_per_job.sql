-- Which AI providers an account has enabled for each job and its default for each job (transcription and
-- analysis), what each project chose per job, and where each conversation's audio began; model
-- calls record the account, the job and the provider the policy sent them to, and the daily
-- provider check keeps its place in the log. Nullable columns and no backfill: every existing
-- account, project and conversation reads as "the environment's default", which is all a
-- deployment with one provider ever offers. The CHECK constraints are added NOT VALID: they
-- still hold for every insert and update, and the lock is taken only for an instant. They are
-- not validated here. The migrations of a release run in one transaction, so a VALIDATE in the
-- same release would hold these locks through its scan of the whole table. Existing rows have
-- NULL in these columns, which the constraints accept; validating them is a later, separate
-- migration of its own release. Safe to run twice.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_provider_check" (
	"name" text PRIMARY KEY NOT NULL,
	"checked_through" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org" ADD COLUMN IF NOT EXISTS "ai_transcription_providers" text[];--> statement-breakpoint
ALTER TABLE "org" ADD COLUMN IF NOT EXISTS "ai_analysis_providers" text[];--> statement-breakpoint
ALTER TABLE "org" ADD COLUMN IF NOT EXISTS "ai_transcription_default" varchar(32);--> statement-breakpoint
ALTER TABLE "org" ADD COLUMN IF NOT EXISTS "ai_analysis_default" varchar(32);--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "ai_transcription_provider" varchar(32);--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "ai_analysis_provider" varchar(32);--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN IF NOT EXISTS "ai_transcription_provider" varchar(32);--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN IF NOT EXISTS "organisation_id" uuid;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN IF NOT EXISTS "routed_provider" text;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN IF NOT EXISTS "routing_job" text;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN IF NOT EXISTS "routing_reason" text;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN IF NOT EXISTS "routing_allowed" text[];--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN IF NOT EXISTS "routing_conversation_id" uuid;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "org" ADD CONSTRAINT "org_ai_transcription_providers_check" CHECK ("org"."ai_transcription_providers" is null or "org"."ai_transcription_providers" <@ array['scaleway', 'google']::text[]) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "org" ADD CONSTRAINT "org_ai_analysis_providers_check" CHECK ("org"."ai_analysis_providers" is null or "org"."ai_analysis_providers" <@ array['scaleway', 'google']::text[]) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "org" ADD CONSTRAINT "org_ai_transcription_default_check" CHECK ("org"."ai_transcription_default" is null or "org"."ai_transcription_default" in ('scaleway', 'google')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "org" ADD CONSTRAINT "org_ai_analysis_default_check" CHECK ("org"."ai_analysis_default" is null or "org"."ai_analysis_default" in ('scaleway', 'google')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "project" ADD CONSTRAINT "project_ai_transcription_provider_check" CHECK ("project"."ai_transcription_provider" is null or "project"."ai_transcription_provider" in ('scaleway', 'google')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "project" ADD CONSTRAINT "project_ai_analysis_provider_check" CHECK ("project"."ai_analysis_provider" is null or "project"."ai_analysis_provider" in ('scaleway', 'google')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "conversation" ADD CONSTRAINT "conversation_ai_transcription_provider_check" CHECK ("conversation"."ai_transcription_provider" is null or "conversation"."ai_transcription_provider" in ('scaleway', 'google')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
