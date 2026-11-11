ALTER TABLE "billing_account" ADD COLUMN IF NOT EXISTS "recording_project_id" uuid;--> statement-breakpoint
ALTER TABLE "conversation_chunk" ADD COLUMN IF NOT EXISTS "audio_seconds" real;