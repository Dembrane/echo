-- When a model_call row was written, which is after its call ended: the daily provider check
-- reads the log by this, so a call that started before one run and was written after it is
-- still read by the next. The column is added without a default and the default set after, so
-- the log is not rewritten: rows from before this stay null and are not read by the check
-- (they carry no routing record to judge). New rows take the clock at the insert. Safe to run
-- twice.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN IF NOT EXISTS "recorded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "model_call" ALTER COLUMN "recorded_at" SET DEFAULT clock_timestamp();
