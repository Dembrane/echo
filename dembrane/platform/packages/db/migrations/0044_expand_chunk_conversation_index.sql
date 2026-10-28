-- Chunks are read by conversation (home search, pipeline, transcripts) and cascade-deleted
-- with it. Prod has carried this index, hand-applied under this name, since before it was in
-- the repo, so there it is a no-op; elsewhere it is a plain build (the runner wraps migrations
-- in one transaction, so no CONCURRENTLY) that locks writes to conversation_chunk while it
-- scans it once. Safe to run twice.
CREATE INDEX IF NOT EXISTS "idx_chunk_conv_timestamp" ON "conversation_chunk" USING btree ("conversation_id","timestamp" DESC NULLS FIRST);
