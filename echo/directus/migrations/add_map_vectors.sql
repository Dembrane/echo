-- Map: the SQL-only half of the schema. Idempotent; safe to run again.
--
-- Run after add_map_schema.py (which creates the three collections):
--   psql -v ON_ERROR_STOP=1 -f add_map_vectors.sql
--
-- Directus does not model pgvector columns, so the vector column, its checks
-- and the indexes the application relies on live here. The column is an
-- unconstrained `vector`: each row records its own `dims`, and a map only ever
-- combines rows of one embedding configuration.
--
-- Rollback: keep this schema and its data, revert the application. Never drop
-- the shared `vector` extension.

\set ON_ERROR_STOP on

BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

DO $$
BEGIN
    IF to_regclass('public.map_result') IS NULL
        OR to_regclass('public.map_embedding') IS NULL
        OR to_regclass('public.map_fact_check') IS NULL THEN
        RAISE EXCEPTION 'Map collections are missing: run add_map_schema.py first';
    END IF;
END
$$;

ALTER TABLE map_embedding ADD COLUMN IF NOT EXISTS embedding vector;
-- Every row is written with its vector in the same statement, so this holds on
-- a fresh table and on every later run.
ALTER TABLE map_embedding ALTER COLUMN embedding SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'map_embedding_dims_match') THEN
        ALTER TABLE map_embedding
            ADD CONSTRAINT map_embedding_dims_match
            CHECK (dims > 0 AND vector_dims(embedding) = dims);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'map_embedding_nonzero') THEN
        ALTER TABLE map_embedding
            ADD CONSTRAINT map_embedding_nonzero
            CHECK (vector_norm(embedding) > 0);
    END IF;
END
$$;

-- One row per exact input per configuration per project: the upsert key.
CREATE UNIQUE INDEX IF NOT EXISTS map_embedding_project_input_config
    ON map_embedding (project_id, input_hash, config_key);

-- Current revision lookup: latest ready result per project.
CREATE INDEX IF NOT EXISTS map_result_project_status_created
    ON map_result (project_id, status, created_at DESC);

-- At most one generation in flight per project.
CREATE UNIQUE INDEX IF NOT EXISTS map_result_one_active_attempt
    ON map_result (project_id)
    WHERE status IN ('queued', 'extracting', 'embedding');

-- One fact-check state per claim revision per project.
CREATE UNIQUE INDEX IF NOT EXISTS map_fact_check_project_claim
    ON map_fact_check (project_id, claim_key);

COMMIT;
