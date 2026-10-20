-- The free tier's staff-editable limits, and each free account's usage per month.
CREATE TABLE IF NOT EXISTS "free_usage" (
	"billing_account_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"key" text NOT NULL,
	"amount" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "free_usage_billing_account_id_period_start_key_pk" PRIMARY KEY("billing_account_id","period_start","key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tier_limit" (
	"tier" text NOT NULL,
	"key" text NOT NULL,
	"value" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "tier_limit_tier_key_pk" PRIMARY KEY("tier","key")
);
