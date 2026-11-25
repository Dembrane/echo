-- migrate: no-transaction
-- Two indexes on model_call, the largest table the app writes to, built without blocking its
-- writes: the daily provider check reads by when a row was written (recorded_at), and the
-- per-organisation cost estimate reads one organisation's last 30 days. The runner takes the
-- marker above and runs this migration's statements one at a time outside a transaction, as
-- CREATE INDEX CONCURRENTLY requires (migrate.ts). A build that fails leaves an invalid index
-- of the same name, so each is dropped first: the migration is recorded only when it finished,
-- so a run that did not finish starts again from the drop.
DROP INDEX CONCURRENTLY IF EXISTS "model_call_recorded_at_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "model_call_recorded_at_idx" ON "model_call" USING btree ("recorded_at");--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "model_call_org_started_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "model_call_org_started_idx" ON "model_call" USING btree ("organisation_id","started_at");
