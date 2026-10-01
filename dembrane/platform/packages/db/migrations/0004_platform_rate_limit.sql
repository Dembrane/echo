-- Unlogged: counters are disposable, and skipping the WAL keeps hot increments cheap.
CREATE UNLOGGED TABLE "platform_rate_limit" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"reset_at" timestamp with time zone NOT NULL
);
