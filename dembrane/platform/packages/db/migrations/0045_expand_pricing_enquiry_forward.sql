-- When a pricing configuration first became submitted, and when the team heard about it
-- without a booking. Only rows submitted after this migration carry submitted_at, so the
-- enquiry outbox never sends the backlog. Adding nullable columns rewrites no rows. Safe
-- to run twice.
ALTER TABLE "pricing_configuration" ADD COLUMN IF NOT EXISTS "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pricing_configuration" ADD COLUMN IF NOT EXISTS "enquiry_notified_at" timestamp with time zone;
