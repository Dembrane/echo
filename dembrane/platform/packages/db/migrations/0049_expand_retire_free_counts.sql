-- The AI budget replaces the free chat, report, map and popcorn counts; their ledger rows and limits go. Safe to run twice.
DELETE FROM "free_usage" WHERE "key" IN ('chats', 'reports', 'maps', 'popcorn_analyses');--> statement-breakpoint
DELETE FROM "tier_limit" WHERE "tier" = 'free' AND "key" IN ('chats_month', 'chat_turns_per_chat', 'reports_month', 'maps_month', 'popcorn_analyses_month');--> statement-breakpoint
-- When a free live recording first got the AI budget stop; later chunks get a short grace from it.
-- A nullable column rewrites no rows. Hot tables go last: the only lock awaited while one is held is billing_account's, below.
ALTER TABLE "conversation" ADD COLUMN IF NOT EXISTS "ai_stopped_at" timestamp with time zone;--> statement-breakpoint
-- Billing accounts get a budget override. Last in the run (all pending migrations share one transaction), so billing reads wait on nothing after this lock.
ALTER TABLE "billing_account" ADD COLUMN IF NOT EXISTS "ai_budget_micro_eur" bigint;--> statement-breakpoint
ALTER TABLE "billing_account" ADD COLUMN IF NOT EXISTS "ai_budget_unlimited" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_account" ADD COLUMN IF NOT EXISTS "ai_budget_until" timestamp with time zone;
