-- Guard functions and triggers on the analysis and map tables, carried over verbatim from
-- echo main. Drizzle does not model them, so they live here. They keep invariants the
-- analysis engine relies on (immutable snapshots, legal state transitions, scope checks)
-- until those checks move into the analysis package and these can be dropped.

CREATE OR REPLACE FUNCTION public.analysis_feedback_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM analysis_object o WHERE o.id = NEW.object_id AND o.project_id = NEW.project_id
    ) THEN
        PERFORM analysis_reference_violation('analysis_feedback.object_id must belong to the same project');
    END IF;
    -- The wording the host was rating, and of the finding they were rating.
    IF NOT EXISTS (
        SELECT 1 FROM analysis_object_revision r
        WHERE r.id = NEW.revision_id AND r.project_id = NEW.project_id AND r.object_id = NEW.object_id
    ) THEN
        PERFORM analysis_reference_violation('analysis_feedback.revision_id must be a revision of this object');
    END IF;
    RETURN NEW;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.analysis_object_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.analysis_object_revision_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.analysis_outbox_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.analysis_reference_violation(message text) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION '%', message USING ERRCODE = 'check_violation';
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.analysis_relation_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.analysis_request_key_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.analysis_run_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.analysis_scope_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.analysis_snapshot_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.analysis_step_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.map_result_snapshot_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
--> statement-breakpoint

CREATE TRIGGER analysis_feedback_guard BEFORE INSERT OR UPDATE ON public.analysis_feedback FOR EACH ROW EXECUTE FUNCTION public.analysis_feedback_guard();
--> statement-breakpoint

CREATE TRIGGER analysis_object_guard BEFORE INSERT OR UPDATE ON public.analysis_object FOR EACH ROW EXECUTE FUNCTION public.analysis_object_guard();
--> statement-breakpoint

CREATE TRIGGER analysis_object_revision_guard BEFORE INSERT OR UPDATE ON public.analysis_object_revision FOR EACH ROW EXECUTE FUNCTION public.analysis_object_revision_guard();
--> statement-breakpoint

CREATE TRIGGER analysis_outbox_guard BEFORE INSERT OR UPDATE ON public.analysis_outbox FOR EACH ROW EXECUTE FUNCTION public.analysis_outbox_guard();
--> statement-breakpoint

CREATE TRIGGER analysis_relation_guard BEFORE INSERT OR UPDATE ON public.analysis_relation FOR EACH ROW EXECUTE FUNCTION public.analysis_relation_guard();
--> statement-breakpoint

CREATE TRIGGER analysis_request_key_guard BEFORE INSERT OR UPDATE ON public.analysis_request_key FOR EACH ROW EXECUTE FUNCTION public.analysis_request_key_guard();
--> statement-breakpoint

CREATE TRIGGER analysis_run_guard BEFORE INSERT OR UPDATE ON public.analysis_run FOR EACH ROW EXECUTE FUNCTION public.analysis_run_guard();
--> statement-breakpoint

CREATE TRIGGER analysis_scope_guard BEFORE INSERT OR UPDATE ON public.analysis_scope FOR EACH ROW EXECUTE FUNCTION public.analysis_scope_guard();
--> statement-breakpoint

CREATE TRIGGER analysis_snapshot_guard BEFORE INSERT OR UPDATE ON public.analysis_snapshot FOR EACH ROW EXECUTE FUNCTION public.analysis_snapshot_guard();
--> statement-breakpoint

CREATE TRIGGER analysis_step_guard BEFORE INSERT OR UPDATE ON public.analysis_step FOR EACH ROW EXECUTE FUNCTION public.analysis_step_guard();
--> statement-breakpoint

CREATE TRIGGER map_result_snapshot_guard BEFORE INSERT OR UPDATE OF snapshot_id, project_id ON public.map_result FOR EACH ROW EXECUTE FUNCTION public.map_result_snapshot_guard();
--> statement-breakpoint
