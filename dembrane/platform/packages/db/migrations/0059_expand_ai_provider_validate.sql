-- The conversation a model call belongs to, and how far the daily provider check has read the
-- log. Then the rows that existed before 0058's constraints are checked: VALIDATE CONSTRAINT
-- scans the table under a lock that lets reads and writes continue, and does nothing for a
-- constraint already valid. Safe to run twice.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN IF NOT EXISTS "routing_conversation_id" uuid;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_provider_check" (
	"name" text PRIMARY KEY NOT NULL,
	"checked_through" timestamp with time zone NOT NULL
);--> statement-breakpoint
ALTER TABLE "org" VALIDATE CONSTRAINT "org_ai_providers_check";--> statement-breakpoint
ALTER TABLE "org" VALIDATE CONSTRAINT "org_ai_default_provider_check";--> statement-breakpoint
ALTER TABLE "project" VALIDATE CONSTRAINT "project_ai_provider_check";--> statement-breakpoint
ALTER TABLE "conversation" VALIDATE CONSTRAINT "conversation_ai_provider_check";
