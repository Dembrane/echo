-- Model calls carry their payer, token kinds and cost; prices, daily FX and daily spend get
-- their own tables. The billing_account override columns are in 0049, the last step of the run. Safe to run twice.
CREATE TABLE IF NOT EXISTS "ai_fx_rate" (
	"day" date PRIMARY KEY NOT NULL,
	"usd_to_eur" numeric NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_price" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"currency" text NOT NULL,
	"input_per_m" numeric,
	"cached_input_per_m" numeric,
	"audio_input_per_m" numeric,
	"output_per_m" numeric,
	"long_context_threshold" integer,
	"long_input_per_m" numeric,
	"long_cached_input_per_m" numeric,
	"long_output_per_m" numeric,
	"per_audio_second" numeric,
	"per_search_query" numeric,
	"source" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_spend_daily" (
	"day" date NOT NULL,
	"billing_account_id" uuid,
	"payer" text DEFAULT 'unattributed' NOT NULL,
	"operation" text DEFAULT '' NOT NULL,
	"model" text NOT NULL,
	"calls" integer NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cost_micro_eur" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN IF NOT EXISTS "provider" text;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN IF NOT EXISTS "billing_account_id" uuid;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN IF NOT EXISTS "project_id" uuid;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN IF NOT EXISTS "payer" text DEFAULT 'unattributed' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN IF NOT EXISTS "counted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN IF NOT EXISTS "cached_input_tokens" integer;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN IF NOT EXISTS "audio_input_tokens" integer;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN IF NOT EXISTS "reasoning_tokens" integer;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN IF NOT EXISTS "audio_seconds" real;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN IF NOT EXISTS "search_queries" integer;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN IF NOT EXISTS "usage_estimated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN IF NOT EXISTS "price_missing" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN IF NOT EXISTS "cost_micro_eur" bigint;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN IF NOT EXISTS "price_id" bigint;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_price_provider_model_effective_from" ON "ai_price" USING btree ("provider","model","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_spend_daily_key" ON "ai_spend_daily" USING btree ("day",coalesce("billing_account_id", '00000000-0000-0000-0000-000000000000'::uuid),"payer","operation","model");--> statement-breakpoint
-- The free tier's monthly AI budget (EUR 5) and whether reaching it blocks AI work.
insert into tier_limit (tier, key, value) values ('free','ai_budget_micro_eur',5000000), ('free','ai_budget_enforce',1) on conflict do nothing;
