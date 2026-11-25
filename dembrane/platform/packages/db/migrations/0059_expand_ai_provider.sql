-- Which AI provider an account may use, which its projects chose, and where each conversation began;
-- model calls record the account and the provider the policy sent them to. Nullable columns and no
-- backfill: every existing account, project and conversation reads as "the environment's default",
-- which is all a deployment with one provider ever offers. The CHECK constraints are added NOT
-- VALID: they still hold for every insert and update, and the lock is taken only for an instant.
-- They are not validated here. The migrations of a release run in one transaction, so a VALIDATE
-- in the same release would hold these locks through its scan of the whole table. Existing rows
-- have NULL in these columns, which the constraints accept; validating them is a later, separate
-- migration of its own release. Safe to run twice.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
ALTER TABLE "org" ADD COLUMN IF NOT EXISTS "ai_providers" text[];--> statement-breakpoint
ALTER TABLE "org" ADD COLUMN IF NOT EXISTS "ai_default_provider" varchar(32);--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "ai_provider" varchar(32);--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN IF NOT EXISTS "ai_provider" varchar(32);--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN IF NOT EXISTS "organisation_id" uuid;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN IF NOT EXISTS "routed_provider" text;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN IF NOT EXISTS "routing_reason" text;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN IF NOT EXISTS "routing_allowed" text[];--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "org" ADD CONSTRAINT "org_ai_providers_check" CHECK ("org"."ai_providers" is null or "org"."ai_providers" <@ array['scaleway', 'google']::text[]) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "org" ADD CONSTRAINT "org_ai_default_provider_check" CHECK ("org"."ai_default_provider" is null or "org"."ai_default_provider" in ('scaleway', 'google')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "project" ADD CONSTRAINT "project_ai_provider_check" CHECK ("project"."ai_provider" is null or "project"."ai_provider" in ('scaleway', 'google')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "conversation" ADD CONSTRAINT "conversation_ai_provider_check" CHECK ("conversation"."ai_provider" is null or "conversation"."ai_provider" in ('scaleway', 'google')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
