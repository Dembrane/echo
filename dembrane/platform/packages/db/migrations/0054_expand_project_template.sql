-- The template a project was created from and its version, for analytics and later onboarding steps. Safe to run twice.
-- Nullable columns rewrite no rows: every existing project reads as made without a template.
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "template_key" varchar(64);--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "template_version" integer;
