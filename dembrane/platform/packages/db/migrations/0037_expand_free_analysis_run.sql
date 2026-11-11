ALTER TABLE "analysis_run" ADD COLUMN IF NOT EXISTS "free_period_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "analysis_run" ADD COLUMN IF NOT EXISTS "free_account_id" uuid;--> statement-breakpoint
-- Plain builds: the runner wraps migrations in one transaction, so no CONCURRENTLY; they lock writes to agent_loop_run while they scan it once.
CREATE INDEX IF NOT EXISTS "agent_loop_run_running_started" ON "agent_loop_run" USING btree ("started_at") WHERE ((status)::text = 'running'::text);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_loop_run_loop_started" ON "agent_loop_run" USING btree ("loop_id","started_at");--> statement-breakpoint
-- Empty at build: no run holds a charge yet.
CREATE INDEX IF NOT EXISTS "analysis_run_free_charged" ON "analysis_run" USING btree ("status") WHERE (free_period_start IS NOT NULL);
