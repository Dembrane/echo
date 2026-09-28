-- Contract: drops the old library, its segment tables, the LightRAG store and the Celery
-- sequences. None has a reader in this stack; the old stack still reads some of them, so
-- this runs at cutover only (MIGRATE_HOLD_CONTRACT=1 holds it back where the old stack
-- shares the database).
--
-- Before this migration runs at cutover, archive the tables that hold data:
--   DATABASE_URL=<prod owner URL> packages/db/scripts/archive-tables.sh
-- It writes one pg_dump per table and a manifest with exact row counts to
-- gs://dembrane-echo-archive/<database>/<stamp>/. Do not run this migration until that
-- manifest lists every table below.
--
-- Rows on prod are pg_class.reltuples estimates from 2026-09-28; sizes include indexes.
--   view                                        856 rows     1 MB   old library
--   aspect                                    8,254 rows    76 MB   old library
--   aspect_segment                              762 rows     2 MB   old library (quotes)
--   insight                                  43,924 rows    39 MB   old library
--   project_analysis_run                        398 rows   0.1 MB   old library runs
--   conversation_segment                    710,264 rows  1.97 GB   segments behind the library
--   conversation_segment_conversation_chunk 3,238,605 rows  442 MB   segment to chunk links
--   lightrag_chunk_graph_map                755,426 rows   214 MB   LightRAG, prod only
--   lightrag_doc_chunks                      35,571 rows   708 MB   LightRAG, prod only
--   lightrag_doc_full                        35,531 rows    90 MB   LightRAG, prod only
--   lightrag_doc_status                      72,673 rows   164 MB   LightRAG, prod only
--   lightrag_llm_cache                       83,043 rows   885 MB   LightRAG, prod only
--   lightrag_vdb_entity                      62,424 rows  1.40 GB   LightRAG, prod only
--   lightrag_vdb_relation                   185,065 rows  3.32 GB   LightRAG, prod only
--   lightrag_vdb_transcript                 830,111 rows 11.86 GB   LightRAG, prod only
-- Also dropped: processing_status.project_analysis_run_id (links statuses to the archived
-- runs) and the sequences task_id_sequence, taskset_id_sequence (Celery, prod only, no data).
-- Directus's metadata rows for these collections go with the directus_* tables at cutover.
DROP TABLE IF EXISTS "aspect_segment" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "aspect" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "view" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "insight" CASCADE;--> statement-breakpoint
ALTER TABLE "processing_status" DROP CONSTRAINT IF EXISTS "processing_status_project_analysis_run_id_foreign";--> statement-breakpoint
ALTER TABLE "processing_status" DROP COLUMN IF EXISTS "project_analysis_run_id";--> statement-breakpoint
DROP TABLE IF EXISTS "project_analysis_run" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "conversation_segment_conversation_chunk" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "conversation_segment" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "lightrag_chunk_graph_map";--> statement-breakpoint
DROP TABLE IF EXISTS "lightrag_doc_chunks";--> statement-breakpoint
DROP TABLE IF EXISTS "lightrag_doc_full";--> statement-breakpoint
DROP TABLE IF EXISTS "lightrag_doc_status";--> statement-breakpoint
DROP TABLE IF EXISTS "lightrag_llm_cache";--> statement-breakpoint
DROP TABLE IF EXISTS "lightrag_vdb_entity";--> statement-breakpoint
DROP TABLE IF EXISTS "lightrag_vdb_relation";--> statement-breakpoint
DROP TABLE IF EXISTS "lightrag_vdb_transcript";--> statement-breakpoint
DROP SEQUENCE IF EXISTS "task_id_sequence";--> statement-breakpoint
DROP SEQUENCE IF EXISTS "taskset_id_sequence";
