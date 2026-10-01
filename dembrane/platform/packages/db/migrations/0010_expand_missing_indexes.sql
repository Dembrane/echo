-- Indexes for foreign keys Postgres was scanning for, measured on prod (pg_stat, 2026-09-27):
--   project_chat.project_id                  1,514,419 full scans on ~14k rows
--   project_chat_message.project_chat_id       835,611 full scans on ~78k rows
--   project_agentic_run_event (run, seq)        50,341 full scans on ~20k rows, growing per run
--   processing_status.parent                  insurance: deletes of a parent scan ~3M rows
-- Prod already has (conversation_id, id) on processing_status and echo-next does not, so it is
-- created if missing; the single-column conversation_id index it covers is then dropped, since
-- every write paid for both. Index changes only, so the old stack is unaffected.
CREATE INDEX IF NOT EXISTS "idx_processing_status_conversation_id_id" ON "processing_status" USING btree ("conversation_id","id");--> statement-breakpoint
DROP INDEX IF EXISTS "processing_status_conversation_id_index";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "processing_status_parent_index" ON "processing_status" USING btree ("parent");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_agentic_run_event_run_seq_index" ON "project_agentic_run_event" USING btree ("project_agentic_run_id","seq");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_chat_project_id_index" ON "project_chat" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_chat_message_project_chat_id_index" ON "project_chat_message" USING btree ("project_chat_id");
