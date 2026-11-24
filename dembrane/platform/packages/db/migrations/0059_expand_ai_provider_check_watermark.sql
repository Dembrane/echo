-- The conversation a model call belongs to, and how far the daily provider check has read the
-- log. Safe to run twice.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN IF NOT EXISTS "routing_conversation_id" uuid;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_provider_check" (
	"name" text PRIMARY KEY NOT NULL,
	"checked_through" timestamp with time zone NOT NULL
);
