-- How long an organisation's audio is kept after a conversation finishes. Null means the default of 30 days.
-- Safe to run twice.
ALTER TABLE "org" ADD COLUMN IF NOT EXISTS "audio_retention_days" integer;--> statement-breakpoint
ALTER TABLE "org" DROP CONSTRAINT IF EXISTS "org_audio_retention_days_check";--> statement-breakpoint
ALTER TABLE "org" ADD CONSTRAINT "org_audio_retention_days_check" CHECK ("org"."audio_retention_days" is null or "org"."audio_retention_days" >= 1);
