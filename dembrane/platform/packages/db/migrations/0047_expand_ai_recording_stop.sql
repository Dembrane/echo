-- When a free live recording first got the AI budget stop; later chunks get a short grace from it.
-- A nullable column rewrites no rows. Safe to run twice.
ALTER TABLE "conversation" ADD COLUMN IF NOT EXISTS "ai_stopped_at" timestamp with time zone;
