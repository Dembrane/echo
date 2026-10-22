-- Null on every existing row: consent was only ever recorded in PostHog, so older conversations stay unknown.
ALTER TABLE "conversation" ADD COLUMN IF NOT EXISTS "consent_given_at" timestamp with time zone;
