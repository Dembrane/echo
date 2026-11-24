-- Which AI provider an account may use, which its projects chose, and where each conversation began;
-- model calls record the account and the provider the policy sent them to. Nullable columns and no
-- backfill: every existing account, project and conversation reads as "the environment's default",
-- which is all a deployment with one provider ever offers. Safe to run twice.
ALTER TABLE "org" ADD COLUMN IF NOT EXISTS "ai_providers" text[];--> statement-breakpoint
ALTER TABLE "org" ADD COLUMN IF NOT EXISTS "ai_default_provider" varchar(32);--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "ai_provider" varchar(32);--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN IF NOT EXISTS "ai_provider" varchar(32);--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN IF NOT EXISTS "organisation_id" uuid;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN IF NOT EXISTS "routed_provider" text;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN IF NOT EXISTS "routing_reason" text;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN IF NOT EXISTS "routing_allowed" text[];--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "org" ADD CONSTRAINT "org_ai_providers_check" CHECK ("org"."ai_providers" is null or "org"."ai_providers" <@ array['scaleway', 'google']::text[]);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "org" ADD CONSTRAINT "org_ai_default_provider_check" CHECK ("org"."ai_default_provider" is null or "org"."ai_default_provider" in ('scaleway', 'google'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "project" ADD CONSTRAINT "project_ai_provider_check" CHECK ("project"."ai_provider" is null or "project"."ai_provider" in ('scaleway', 'google'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "conversation" ADD CONSTRAINT "conversation_ai_provider_check" CHECK ("conversation"."ai_provider" is null or "conversation"."ai_provider" in ('scaleway', 'google'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
