-- Shared analysis objects and recipe runs: the SQL-only half of the schema.
-- Idempotent and transactional; safe to run again.
--
-- Run after add_analysis_schema.py (which creates the ten collections and
-- the two map_result fields):
--   psql -v ON_ERROR_STOP=1 -f add_analysis_constraints.sql
--
-- Directus models columns and foreign keys. The unique keys the lifecycle
-- relies on, the composite and partial indexes, the CHECK constraints on status
-- values and hash versions, and the same-project and immutability triggers live
-- here. Index names never follow Directus's `{table}_{field}_index` convention,
-- and no single-column index is created, so a later snapshot push leaves them in
-- place (see docs/incidents/directus-sync-is-indexed.md).
--
-- Every name below is resolved through the search_path, so the same file can
-- be applied to a throwaway test schema.
--
-- Rollback: keep this schema and its data, revert the application.

\set ON_ERROR_STOP on

BEGIN;

DO $$
BEGIN
    IF to_regclass('analysis_scope') IS NULL
        OR to_regclass('analysis_run') IS NULL
        OR to_regclass('analysis_step') IS NULL
        OR to_regclass('analysis_object') IS NULL
        OR to_regclass('analysis_object_revision') IS NULL
        OR to_regclass('analysis_relation') IS NULL
        OR to_regclass('analysis_snapshot') IS NULL
        OR to_regclass('analysis_outbox') IS NULL
        OR to_regclass('analysis_request_key') IS NULL
        OR to_regclass('analysis_last_opened') IS NULL THEN
        RAISE EXCEPTION 'analysis collections are missing: run add_analysis_schema.py first';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = to_regclass('map_result') AND attname = 'snapshot_id' AND NOT attisdropped
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = to_regclass('analysis_run') AND attname = 'lease_expires_at' AND NOT attisdropped
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = to_regclass('analysis_snapshot') AND attname = 'source_event_id' AND NOT attisdropped
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = to_regclass('analysis_object_revision') AND attname = 'change_kind' AND NOT attisdropped
    ) THEN
        RAISE EXCEPTION 'analysis fields are missing: run add_analysis_schema.py first';
    END IF;
END
$$;

-- ── CHECK constraints ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pg_temp.analysis_add_check(tbl text, name text, definition text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass(tbl) AND conname = name
    ) THEN
        EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK (%s)', to_regclass(tbl), name, definition);
    END IF;
END
$$;

SELECT pg_temp.analysis_add_check('analysis_scope', 'analysis_scope_kind_valid',
    $c$(kind = 'producer' AND recipe_id IS NOT NULL AND view_id IS NULL AND current_snapshot_id IS NULL)
       OR (kind = 'view' AND view_id IS NOT NULL AND recipe_id IS NULL AND current_run_id IS NULL)$c$);
SELECT pg_temp.analysis_add_check('analysis_scope', 'analysis_scope_writer_valid',
    $c$writer IN ('legacy', 'analysis')$c$);
SELECT pg_temp.analysis_add_check('analysis_scope', 'analysis_scope_counters_valid',
    $c$next_request_order >= 1 AND generation_epoch >= 0 AND publication_sequence >= 0
       AND writer_fence >= 0 AND (current_request_order IS NULL OR current_request_order >= 1)$c$);

SELECT pg_temp.analysis_add_check('analysis_run', 'analysis_run_status_valid',
    $c$status IN ('queued', 'waiting_for_inputs', 'running', 'needs_review', 'ready', 'failed',
                  'cancelled', 'superseded')$c$);
SELECT pg_temp.analysis_add_check('analysis_run', 'analysis_run_mode_valid',
    $c$mode IN ('refresh', 'regenerate', 'retry')$c$);
SELECT pg_temp.analysis_add_check('analysis_run', 'analysis_run_hash_version_valid',
    $c$hash_version = 'c14n-v1'$c$);
SELECT pg_temp.analysis_add_check('analysis_run', 'analysis_run_counters_valid',
    $c$request_order >= 1 AND epoch >= 0 AND attempt >= 0$c$);
SELECT pg_temp.analysis_add_check('analysis_run', 'analysis_run_writer_fence_valid',
    $c$writer_fence >= 0$c$);
SELECT pg_temp.analysis_add_check('analysis_run', 'analysis_run_ready_has_manifest',
    $c$status <> 'ready' OR output_manifest IS NOT NULL$c$);
SELECT pg_temp.analysis_add_check('analysis_run', 'analysis_run_running_has_lease',
    $c$status <> 'running' OR (lease IS NOT NULL AND lease_expires_at IS NOT NULL)$c$);

SELECT pg_temp.analysis_add_check('analysis_step', 'analysis_step_kind_valid',
    $c$kind IN ('model', 'deterministic', 'check')$c$);
SELECT pg_temp.analysis_add_check('analysis_step', 'analysis_step_status_valid',
    $c$status IN ('running', 'completed', 'failed')$c$);
SELECT pg_temp.analysis_add_check('analysis_step', 'analysis_step_hash_version_valid',
    $c$hash_version = 'c14n-v1'$c$);
SELECT pg_temp.analysis_add_check('analysis_step', 'analysis_step_attempt_valid',
    $c$attempt >= 1$c$);

SELECT pg_temp.analysis_add_check('analysis_object', 'analysis_object_revision_count_valid',
    $c$revision_count >= 0$c$);

SELECT pg_temp.analysis_add_check('analysis_object_revision', 'analysis_object_revision_status_valid',
    $c$status IN ('staged', 'candidate', 'published', 'discarded')$c$);
SELECT pg_temp.analysis_add_check('analysis_object_revision', 'analysis_object_revision_origin_valid',
    $c$origin IN ('generated', 'authored', 'imported')$c$);
SELECT pg_temp.analysis_add_check('analysis_object_revision', 'analysis_object_revision_hash_version_valid',
    $c$hash_version = 'c14n-v1'$c$);
SELECT pg_temp.analysis_add_check('analysis_object_revision', 'analysis_object_revision_numbers_valid',
    $c$revision_number >= 1 AND schema_version >= 1$c$);
-- Generated output names its run and recipe in its provenance, which outlives
-- the run row itself.
SELECT pg_temp.analysis_add_check('analysis_object_revision', 'analysis_object_revision_generated_provenance',
    $c$origin <> 'generated'
       OR ((provenance::jsonb ->> 'runId') IS NOT NULL AND (provenance::jsonb ->> 'recipeId') IS NOT NULL)$c$);
SELECT pg_temp.analysis_add_check('analysis_object_revision', 'analysis_object_revision_published_at',
    $c$status <> 'published' OR published_at IS NOT NULL$c$);
-- What the host said they changed. Null is "not recorded": generated
-- revisions have none, and neither has anything written before the audit
-- trail asked. Nothing is backfilled.
SELECT pg_temp.analysis_add_check('analysis_object_revision', 'analysis_object_revision_change_kind_valid',
    $c$change_kind IS NULL
       OR change_kind IN ('typo', 'clarity', 'meaning', 'withdraw', 'restore', 'rollback')$c$);
-- Only a host records a kind, and only on a revision they wrote.
SELECT pg_temp.analysis_add_check('analysis_object_revision', 'analysis_object_revision_change_kind_authored',
    $c$change_kind IS NULL OR origin = 'authored'$c$);

SELECT pg_temp.analysis_add_check('analysis_relation', 'analysis_relation_basis_valid',
    $c$basis IN ('extracted', 'inferred', 'authored')$c$);
SELECT pg_temp.analysis_add_check('analysis_relation', 'analysis_relation_status_valid',
    $c$status IN ('staged', 'published', 'discarded')$c$);
SELECT pg_temp.analysis_add_check('analysis_relation', 'analysis_relation_hash_version_valid',
    $c$hash_version = 'c14n-v1'$c$);
SELECT pg_temp.analysis_add_check('analysis_relation', 'analysis_relation_not_reflexive',
    $c$from_revision_id <> to_revision_id$c$);

SELECT pg_temp.analysis_add_check('analysis_snapshot', 'analysis_snapshot_hash_version_valid',
    $c$hash_version = 'c14n-v1'$c$);
SELECT pg_temp.analysis_add_check('analysis_snapshot', 'analysis_snapshot_manifest_version_valid',
    $c$manifest_version >= 1$c$);

SELECT pg_temp.analysis_add_check('analysis_outbox', 'analysis_outbox_status_valid',
    $c$status IN ('pending', 'dispatching', 'delivered', 'dead')$c$);
SELECT pg_temp.analysis_add_check('analysis_outbox', 'analysis_outbox_counters_valid',
    $c$sequence >= 1 AND attempts >= 0$c$);
-- No CHECK ties an event to its run or snapshot: deleting a project sets those
-- references to NULL in whatever order its cascades run, and a CHECK over a
-- SET NULL reference would abort the deletion.

SELECT pg_temp.analysis_add_check('analysis_request_key', 'analysis_request_key_mode_valid',
    $c$mode IN ('refresh', 'regenerate', 'retry')$c$);

SELECT pg_temp.analysis_add_check('analysis_last_opened', 'analysis_last_opened_user_present',
    $c$length(btrim(user_id)) > 0$c$);

SELECT pg_temp.analysis_add_check('map_result', 'map_result_manifest_version_valid',
    $c$manifest_version IN (1, 2)$c$);

-- ── unique keys ─────────────────────────────────────────────────────────

-- One producer scope per recipe and input scope, one view scope per view.
CREATE UNIQUE INDEX IF NOT EXISTS analysis_scope_producer_identity
    ON analysis_scope (project_id, recipe_id, scope_key) WHERE kind = 'producer';
CREATE UNIQUE INDEX IF NOT EXISTS analysis_scope_view_identity
    ON analysis_scope (project_id, view_id, scope_key) WHERE kind = 'view';

-- The key a run was created under.
CREATE UNIQUE INDEX IF NOT EXISTS analysis_run_project_idempotency
    ON analysis_run (project_id, idempotency_key);
-- Every key a request was accepted under, including keys that joined work in
-- flight or retried a failed run: a repeated transport request returns its run.
CREATE UNIQUE INDEX IF NOT EXISTS analysis_request_key_project_key
    ON analysis_request_key (project_id, idempotency_key);
-- One row per host per project: the results list has one last-opened time,
-- and marking it opened again writes that row rather than another.
CREATE UNIQUE INDEX IF NOT EXISTS analysis_last_opened_project_user
    ON analysis_last_opened (project_id, user_id);
-- Request order is unique within a scope; publication compares it.
CREATE UNIQUE INDEX IF NOT EXISTS analysis_run_scope_request_order
    ON analysis_run (scope_id, request_order);
-- Equivalent in-flight work in one scope is one run.
CREATE UNIQUE INDEX IF NOT EXISTS analysis_run_one_active_request
    ON analysis_run (scope_id, request_fingerprint)
    WHERE status IN ('queued', 'waiting_for_inputs', 'running');

CREATE UNIQUE INDEX IF NOT EXISTS analysis_step_run_step
    ON analysis_step (run_id, step_key);

CREATE UNIQUE INDEX IF NOT EXISTS analysis_object_project_lineage
    ON analysis_object (project_id, type, lineage_key);

CREATE UNIQUE INDEX IF NOT EXISTS analysis_object_revision_object_number
    ON analysis_object_revision (object_id, revision_number);
-- A run stages at most one candidate revision per object; a replay updates it.
CREATE UNIQUE INDEX IF NOT EXISTS analysis_object_revision_one_staged_per_run
    ON analysis_object_revision (run_id, object_id) WHERE status IN ('staged', 'candidate');

CREATE UNIQUE INDEX IF NOT EXISTS analysis_relation_one_staged_per_run
    ON analysis_relation (run_id, type, from_revision_id, to_revision_id) WHERE status = 'staged';

-- A snapshot assembled for an outbox event is that consumer's durable effect:
-- a repeated dispatch finds it instead of assembling another.
CREATE UNIQUE INDEX IF NOT EXISTS analysis_snapshot_scope_source_event
    ON analysis_snapshot (scope_id, source_event_id) WHERE source_event_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS analysis_outbox_scope_sequence
    ON analysis_outbox (scope_id, sequence);

-- ── lookup indexes ──────────────────────────────────────────────────────

-- Reusable step artifacts within one project.
CREATE INDEX IF NOT EXISTS analysis_step_project_cache
    ON analysis_step (project_id, cache_key, completed_at DESC)
    WHERE status = 'completed' AND reused_step_id IS NULL;
CREATE INDEX IF NOT EXISTS analysis_run_scope_status_created
    ON analysis_run (scope_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS analysis_run_waiting_by_project
    ON analysis_run (project_id, created_at) WHERE status = 'waiting_for_inputs';
-- Running runs under a live lease, per recipe (backpressure) and by deadline
-- (the expiry sweep).
CREATE INDEX IF NOT EXISTS analysis_run_running_lease
    ON analysis_run (recipe_id, lease_expires_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS analysis_run_running_expiry
    ON analysis_run (lease_expires_at, id) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS analysis_object_revision_run_status
    ON analysis_object_revision (run_id, status);
CREATE INDEX IF NOT EXISTS analysis_relation_run_status
    ON analysis_relation (run_id, status);
CREATE INDEX IF NOT EXISTS analysis_relation_published_to
    ON analysis_relation (to_revision_id, type) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS analysis_relation_published_from
    ON analysis_relation (from_revision_id, type) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS analysis_snapshot_scope_created
    ON analysis_snapshot (scope_id, created_at DESC);
CREATE INDEX IF NOT EXISTS analysis_outbox_due
    ON analysis_outbox (next_attempt_at, created_at) WHERE status IN ('pending', 'dispatching');
CREATE INDEX IF NOT EXISTS analysis_request_key_run
    ON analysis_request_key (run_id, created_at);

-- ── same-project and immutability triggers ──────────────────────────────
--
-- A foreign key proves a referenced row exists; these prove it belongs to the
-- same project (and, where it matters, the same scope or object). ON DELETE
-- SET NULL arrives as an UPDATE, so the immutability guards allow a reference
-- becoming NULL and nothing else.

CREATE OR REPLACE FUNCTION analysis_reference_violation(message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '%', message USING ERRCODE = 'check_violation';
END
$$;

CREATE OR REPLACE FUNCTION analysis_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.current_run_id IS NOT NULL
        AND (TG_OP = 'INSERT' OR NEW.current_run_id IS DISTINCT FROM OLD.current_run_id)
        AND NOT EXISTS (
            SELECT 1 FROM analysis_run r
            WHERE r.id = NEW.current_run_id AND r.project_id = NEW.project_id
              AND r.scope_id = NEW.id AND r.status = 'ready'
        ) THEN
        PERFORM analysis_reference_violation('analysis_scope.current_run_id must be a ready run of this scope');
    END IF;
    IF NEW.current_snapshot_id IS NOT NULL
        AND (TG_OP = 'INSERT' OR NEW.current_snapshot_id IS DISTINCT FROM OLD.current_snapshot_id)
        AND NOT EXISTS (
            SELECT 1 FROM analysis_snapshot s
            WHERE s.id = NEW.current_snapshot_id AND s.project_id = NEW.project_id AND s.scope_id = NEW.id
        ) THEN
        PERFORM analysis_reference_violation('analysis_scope.current_snapshot_id must be a snapshot of this scope');
    END IF;
    RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION analysis_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.scope_id IS DISTINCT FROM OLD.scope_id
        OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
        IF NOT EXISTS (
            SELECT 1 FROM analysis_scope s
            WHERE s.id = NEW.scope_id AND s.project_id = NEW.project_id
              AND s.kind = 'producer' AND s.recipe_id = NEW.recipe_id
        ) THEN
            PERFORM analysis_reference_violation('analysis_run.scope_id must be a producer scope of this project and recipe');
        END IF;
    END IF;
    IF NEW.reused_run_id IS NOT NULL
        AND (TG_OP = 'INSERT' OR NEW.reused_run_id IS DISTINCT FROM OLD.reused_run_id)
        AND NOT EXISTS (
            SELECT 1 FROM analysis_run r WHERE r.id = NEW.reused_run_id AND r.project_id = NEW.project_id
        ) THEN
        PERFORM analysis_reference_violation('analysis_run.reused_run_id must belong to the same project');
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'ready'
        AND (NEW.status IS DISTINCT FROM OLD.status
             OR NEW.output_manifest::jsonb IS DISTINCT FROM OLD.output_manifest::jsonb
             OR NEW.input_manifest::jsonb IS DISTINCT FROM OLD.input_manifest::jsonb) THEN
        PERFORM analysis_reference_violation('a ready analysis_run is immutable');
    END IF;
    -- Pinned inputs are written once.
    IF TG_OP = 'UPDATE' AND OLD.input_manifest IS NOT NULL
        AND (NEW.input_manifest::jsonb IS DISTINCT FROM OLD.input_manifest::jsonb
             OR NEW.input_fingerprint IS DISTINCT FROM OLD.input_fingerprint) THEN
        PERFORM analysis_reference_violation('an analysis_run''s pinned inputs are immutable');
    END IF;
    RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION analysis_step_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (TG_OP = 'INSERT' OR NEW.run_id IS DISTINCT FROM OLD.run_id)
        AND NOT EXISTS (
            SELECT 1 FROM analysis_run r WHERE r.id = NEW.run_id AND r.project_id = NEW.project_id
        ) THEN
        PERFORM analysis_reference_violation('analysis_step.run_id must belong to the same project');
    END IF;
    IF NEW.reused_step_id IS NOT NULL
        AND (TG_OP = 'INSERT' OR NEW.reused_step_id IS DISTINCT FROM OLD.reused_step_id)
        AND NOT EXISTS (
            SELECT 1 FROM analysis_step s
            WHERE s.id = NEW.reused_step_id AND s.project_id = NEW.project_id
              AND s.cache_key = NEW.cache_key AND s.status = 'completed'
        ) THEN
        PERFORM analysis_reference_violation('analysis_step.reused_step_id must be a completed step of the same project and cache key');
    END IF;
    -- A completed step is an artifact other runs may reuse: never rewritten.
    IF TG_OP = 'UPDATE' AND OLD.status = 'completed'
        AND ((to_jsonb(NEW) - 'reused_step_id' - 'updated_at') IS DISTINCT FROM
             (to_jsonb(OLD) - 'reused_step_id' - 'updated_at')
             OR (NEW.reused_step_id IS DISTINCT FROM OLD.reused_step_id AND NEW.reused_step_id IS NOT NULL)) THEN
        PERFORM analysis_reference_violation('a completed analysis_step is immutable');
    END IF;
    RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION analysis_object_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.scope_id IS NOT NULL
        AND (TG_OP = 'INSERT' OR NEW.scope_id IS DISTINCT FROM OLD.scope_id)
        AND NOT EXISTS (
            SELECT 1 FROM analysis_scope s WHERE s.id = NEW.scope_id AND s.project_id = NEW.project_id
        ) THEN
        PERFORM analysis_reference_violation('analysis_object.scope_id must belong to the same project');
    END IF;
    IF NEW.current_revision_id IS NOT NULL
        AND (TG_OP = 'INSERT' OR NEW.current_revision_id IS DISTINCT FROM OLD.current_revision_id)
        AND NOT EXISTS (
            SELECT 1 FROM analysis_object_revision v
            WHERE v.id = NEW.current_revision_id AND v.project_id = NEW.project_id
              AND v.object_id = NEW.id AND v.status = 'published'
        ) THEN
        PERFORM analysis_reference_violation('analysis_object.current_revision_id must be a published revision of this object');
    END IF;
    IF TG_OP = 'UPDATE' AND (NEW.type IS DISTINCT FROM OLD.type
                             OR NEW.lineage_key IS DISTINCT FROM OLD.lineage_key
                             OR NEW.project_id IS DISTINCT FROM OLD.project_id) THEN
        PERFORM analysis_reference_violation('an analysis_object keeps its project, type and lineage key');
    END IF;
    RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION analysis_object_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.object_id IS DISTINCT FROM OLD.object_id
        OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.type IS DISTINCT FROM OLD.type THEN
        IF NOT EXISTS (
            SELECT 1 FROM analysis_object o
            WHERE o.id = NEW.object_id AND o.project_id = NEW.project_id AND o.type = NEW.type
        ) THEN
            PERFORM analysis_reference_violation('analysis_object_revision must match its object''s project and type');
        END IF;
    END IF;
    IF NEW.run_id IS NOT NULL
        AND (TG_OP = 'INSERT' OR NEW.run_id IS DISTINCT FROM OLD.run_id)
        AND NOT EXISTS (
            SELECT 1 FROM analysis_run r WHERE r.id = NEW.run_id AND r.project_id = NEW.project_id
        ) THEN
        PERFORM analysis_reference_violation('analysis_object_revision.run_id must belong to the same project');
    END IF;
    IF NEW.parent_revision_id IS NOT NULL
        AND (TG_OP = 'INSERT' OR NEW.parent_revision_id IS DISTINCT FROM OLD.parent_revision_id)
        AND NOT EXISTS (
            SELECT 1 FROM analysis_object_revision p
            WHERE p.id = NEW.parent_revision_id AND p.project_id = NEW.project_id
              AND p.object_id = NEW.object_id
        ) THEN
        PERFORM analysis_reference_violation('analysis_object_revision.parent_revision_id must be a revision of the same object');
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'published' AND (
        NEW.status IS DISTINCT FROM OLD.status
        OR NEW.object_id IS DISTINCT FROM OLD.object_id
        OR NEW.revision_number IS DISTINCT FROM OLD.revision_number
        OR NEW.type IS DISTINCT FROM OLD.type
        OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
        OR NEW.origin IS DISTINCT FROM OLD.origin
        OR NEW.payload::jsonb IS DISTINCT FROM OLD.payload::jsonb
        OR NEW.attributes::jsonb IS DISTINCT FROM OLD.attributes::jsonb
        OR NEW.provenance::jsonb IS DISTINCT FROM OLD.provenance::jsonb
        OR NEW.embedding_refs::jsonb IS DISTINCT FROM OLD.embedding_refs::jsonb
        OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
        OR NEW.change_kind IS DISTINCT FROM OLD.change_kind
        OR NEW.published_at IS DISTINCT FROM OLD.published_at
        OR (NEW.run_id IS DISTINCT FROM OLD.run_id AND NEW.run_id IS NOT NULL)
        OR (NEW.parent_revision_id IS DISTINCT FROM OLD.parent_revision_id AND NEW.parent_revision_id IS NOT NULL)
    ) THEN
        PERFORM analysis_reference_violation('a published analysis_object_revision is immutable');
    END IF;
    RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION analysis_relation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.from_revision_id IS DISTINCT FROM OLD.from_revision_id
        OR NEW.from_object_id IS DISTINCT FROM OLD.from_object_id
        OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
        IF NOT EXISTS (
            SELECT 1 FROM analysis_object_revision v
            WHERE v.id = NEW.from_revision_id AND v.project_id = NEW.project_id
              AND v.object_id = NEW.from_object_id
        ) THEN
            PERFORM analysis_reference_violation('analysis_relation.from_revision_id must be a revision of from_object_id in the same project');
        END IF;
    END IF;
    IF TG_OP = 'INSERT' OR NEW.to_revision_id IS DISTINCT FROM OLD.to_revision_id
        OR NEW.to_object_id IS DISTINCT FROM OLD.to_object_id
        OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
        IF NOT EXISTS (
            SELECT 1 FROM analysis_object_revision v
            WHERE v.id = NEW.to_revision_id AND v.project_id = NEW.project_id
              AND v.object_id = NEW.to_object_id
        ) THEN
            PERFORM analysis_reference_violation('analysis_relation.to_revision_id must be a revision of to_object_id in the same project');
        END IF;
    END IF;
    IF NEW.run_id IS NOT NULL
        AND (TG_OP = 'INSERT' OR NEW.run_id IS DISTINCT FROM OLD.run_id)
        AND NOT EXISTS (
            SELECT 1 FROM analysis_run r WHERE r.id = NEW.run_id AND r.project_id = NEW.project_id
        ) THEN
        PERFORM analysis_reference_violation('analysis_relation.run_id must belong to the same project');
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'published' AND (
        NEW.status IS DISTINCT FROM OLD.status
        OR NEW.type IS DISTINCT FROM OLD.type
        OR NEW.basis IS DISTINCT FROM OLD.basis
        OR NEW.from_revision_id IS DISTINCT FROM OLD.from_revision_id
        OR NEW.to_revision_id IS DISTINCT FROM OLD.to_revision_id
        OR NEW.attributes::jsonb IS DISTINCT FROM OLD.attributes::jsonb
        OR NEW.provenance::jsonb IS DISTINCT FROM OLD.provenance::jsonb
        OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
        OR (NEW.run_id IS DISTINCT FROM OLD.run_id AND NEW.run_id IS NOT NULL)
    ) THEN
        PERFORM analysis_reference_violation('a published analysis_relation is immutable');
    END IF;
    RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION analysis_snapshot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        -- Only the parent reference may change, and only to NULL (its parent
        -- was deleted). Every other column, settings included, stays.
        IF NEW.parent_snapshot_id IS NULL AND OLD.parent_snapshot_id IS NOT NULL
            AND (to_jsonb(NEW) - 'parent_snapshot_id') = (to_jsonb(OLD) - 'parent_snapshot_id') THEN
            RETURN NEW;
        END IF;
        PERFORM analysis_reference_violation('an analysis_snapshot is immutable');
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM analysis_scope s
        WHERE s.id = NEW.scope_id AND s.project_id = NEW.project_id
          AND s.kind = 'view' AND s.view_id = NEW.view_id
    ) THEN
        PERFORM analysis_reference_violation('analysis_snapshot.scope_id must be a view scope of this project and view');
    END IF;
    IF NEW.parent_snapshot_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM analysis_snapshot p WHERE p.id = NEW.parent_snapshot_id AND p.project_id = NEW.project_id
    ) THEN
        PERFORM analysis_reference_violation('analysis_snapshot.parent_snapshot_id must belong to the same project');
    END IF;
    RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION analysis_outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (TG_OP = 'INSERT' OR NEW.scope_id IS DISTINCT FROM OLD.scope_id)
        AND NOT EXISTS (
            SELECT 1 FROM analysis_scope s WHERE s.id = NEW.scope_id AND s.project_id = NEW.project_id
        ) THEN
        PERFORM analysis_reference_violation('analysis_outbox.scope_id must belong to the same project');
    END IF;
    IF NEW.run_id IS NOT NULL
        AND (TG_OP = 'INSERT' OR NEW.run_id IS DISTINCT FROM OLD.run_id)
        AND NOT EXISTS (
            SELECT 1 FROM analysis_run r WHERE r.id = NEW.run_id AND r.project_id = NEW.project_id
        ) THEN
        PERFORM analysis_reference_violation('analysis_outbox.run_id must belong to the same project');
    END IF;
    IF NEW.snapshot_id IS NOT NULL
        AND (TG_OP = 'INSERT' OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id)
        AND NOT EXISTS (
            SELECT 1 FROM analysis_snapshot s WHERE s.id = NEW.snapshot_id AND s.project_id = NEW.project_id
        ) THEN
        PERFORM analysis_reference_violation('analysis_outbox.snapshot_id must belong to the same project');
    END IF;
    RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION analysis_request_key_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND (NEW.project_id, NEW.idempotency_key, NEW.run_id, NEW.scope_id)
        IS DISTINCT FROM (OLD.project_id, OLD.idempotency_key, OLD.run_id, OLD.scope_id) THEN
        PERFORM analysis_reference_violation('an analysis_request_key is immutable');
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM analysis_run r
        WHERE r.id = NEW.run_id AND r.project_id = NEW.project_id AND r.scope_id = NEW.scope_id
    ) THEN
        PERFORM analysis_reference_violation('analysis_request_key.run_id must be a run of this project and scope');
    END IF;
    RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION map_result_snapshot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.snapshot_id IS NOT NULL
        AND (TG_OP = 'INSERT' OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id)
        AND NOT EXISTS (
            SELECT 1 FROM analysis_snapshot s WHERE s.id = NEW.snapshot_id AND s.project_id = NEW.project_id
        ) THEN
        PERFORM analysis_reference_violation('map_result.snapshot_id must be a snapshot of the same project');
    END IF;
    RETURN NEW;
END
$$;

CREATE OR REPLACE TRIGGER analysis_scope_guard
    BEFORE INSERT OR UPDATE ON analysis_scope
    FOR EACH ROW EXECUTE FUNCTION analysis_scope_guard();
CREATE OR REPLACE TRIGGER analysis_run_guard
    BEFORE INSERT OR UPDATE ON analysis_run
    FOR EACH ROW EXECUTE FUNCTION analysis_run_guard();
CREATE OR REPLACE TRIGGER analysis_step_guard
    BEFORE INSERT OR UPDATE ON analysis_step
    FOR EACH ROW EXECUTE FUNCTION analysis_step_guard();
CREATE OR REPLACE TRIGGER analysis_object_guard
    BEFORE INSERT OR UPDATE ON analysis_object
    FOR EACH ROW EXECUTE FUNCTION analysis_object_guard();
CREATE OR REPLACE TRIGGER analysis_object_revision_guard
    BEFORE INSERT OR UPDATE ON analysis_object_revision
    FOR EACH ROW EXECUTE FUNCTION analysis_object_revision_guard();
CREATE OR REPLACE TRIGGER analysis_relation_guard
    BEFORE INSERT OR UPDATE ON analysis_relation
    FOR EACH ROW EXECUTE FUNCTION analysis_relation_guard();
CREATE OR REPLACE TRIGGER analysis_snapshot_guard
    BEFORE INSERT OR UPDATE ON analysis_snapshot
    FOR EACH ROW EXECUTE FUNCTION analysis_snapshot_guard();
CREATE OR REPLACE TRIGGER analysis_outbox_guard
    BEFORE INSERT OR UPDATE ON analysis_outbox
    FOR EACH ROW EXECUTE FUNCTION analysis_outbox_guard();
CREATE OR REPLACE TRIGGER analysis_request_key_guard
    BEFORE INSERT OR UPDATE ON analysis_request_key
    FOR EACH ROW EXECUTE FUNCTION analysis_request_key_guard();
CREATE OR REPLACE TRIGGER map_result_snapshot_guard
    BEFORE INSERT OR UPDATE OF snapshot_id, project_id ON map_result
    FOR EACH ROW EXECUTE FUNCTION map_result_snapshot_guard();

COMMIT;
