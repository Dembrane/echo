-- migrate: no-transaction
-- Two indexes on model_call, the largest table the app writes to, built without blocking its
-- writes: the daily provider check reads by when a row was written (recorded_at), and the
-- per-organisation cost estimate reads one organisation's last 30 days. The runner takes the
-- marker above and runs this migration's statements one at a time outside a transaction, as
-- CREATE INDEX CONCURRENTLY requires (migrate.ts). An index that exists and is valid is kept,
-- so a deploy after a build that outlived its job does not start it over; the runner drops one
-- that is invalid (a build that failed leaves one) just before this statement rebuilds it. The
-- migration is recorded only when its last statement finished, so a run that did not finish
-- starts again from the first.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "model_call_recorded_at_idx" ON "model_call" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "model_call_org_started_idx" ON "model_call" USING btree ("organisation_id","started_at");
