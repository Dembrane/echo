--
-- PostgreSQL database dump
--

\restrict parityfixture

-- Dumped from database version 16.12 (Debian 16.12-1.pgdg12+1)
-- Dumped by pg_dump version 16.12 (Debian 16.12-1.pgdg12+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


--
-- Name: analysis_feedback_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.analysis_feedback_guard() RETURNS trigger
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


--
-- Name: analysis_object_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.analysis_object_guard() RETURNS trigger
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


--
-- Name: analysis_object_revision_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.analysis_object_revision_guard() RETURNS trigger
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


--
-- Name: analysis_outbox_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.analysis_outbox_guard() RETURNS trigger
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


--
-- Name: analysis_reference_violation(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.analysis_reference_violation(message text) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION '%', message USING ERRCODE = 'check_violation';
END
$$;


--
-- Name: analysis_relation_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.analysis_relation_guard() RETURNS trigger
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


--
-- Name: analysis_request_key_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.analysis_request_key_guard() RETURNS trigger
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


--
-- Name: analysis_run_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.analysis_run_guard() RETURNS trigger
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


--
-- Name: analysis_scope_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.analysis_scope_guard() RETURNS trigger
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


--
-- Name: analysis_snapshot_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.analysis_snapshot_guard() RETURNS trigger
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


--
-- Name: analysis_step_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.analysis_step_guard() RETURNS trigger
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


--
-- Name: map_result_snapshot_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.map_result_snapshot_guard() RETURNS trigger
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


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: access_request; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.access_request (
    actioned_at timestamp with time zone,
    actioned_by uuid,
    deleted_at timestamp with time zone,
    id uuid NOT NULL,
    requested_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    status character varying(255) DEFAULT 'pending'::character varying NOT NULL,
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL
);


--
-- Name: agent_audit_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_audit_event (
    app_user_id uuid NOT NULL,
    client_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    duration_ms integer,
    grant_id uuid NOT NULL,
    id uuid NOT NULL,
    org_id uuid,
    params json,
    status character varying(255) DEFAULT NULL::character varying NOT NULL,
    tool character varying(255) DEFAULT NULL::character varying NOT NULL
);


--
-- Name: agent_client; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_client (
    client_name character varying(255) DEFAULT NULL::character varying,
    client_secret_encrypted text,
    created_at timestamp with time zone NOT NULL,
    id uuid NOT NULL,
    last_seen_at timestamp with time zone,
    metadata json,
    redirect_uris json,
    token_endpoint_auth_method character varying(255) DEFAULT NULL::character varying
);


--
-- Name: agent_grant; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_grant (
    app_user_id uuid NOT NULL,
    client_id uuid NOT NULL,
    client_name character varying(255) DEFAULT NULL::character varying,
    consent_accepted_at timestamp with time zone NOT NULL,
    consent_version character varying(255) DEFAULT NULL::character varying,
    created_at timestamp with time zone NOT NULL,
    directus_user_id uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    id uuid NOT NULL,
    last_used_at timestamp with time zone,
    org_ids json,
    revoked_at timestamp with time zone,
    scopes json
);


--
-- Name: agent_insight; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_insight (
    chat_id character varying(255) DEFAULT NULL::character varying,
    content text NOT NULL,
    created_at timestamp with time zone,
    id uuid NOT NULL,
    kind character varying(255) DEFAULT NULL::character varying NOT NULL,
    message_id character varying(255) DEFAULT NULL::character varying,
    project_id character varying(255) DEFAULT NULL::character varying,
    source character varying(255) DEFAULT NULL::character varying,
    status character varying(255) DEFAULT 'new'::character varying,
    suggested_capability text,
    workspace_id character varying(255) DEFAULT NULL::character varying
);


--
-- Name: agent_loop; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_loop (
    acting_directus_user_id character varying(255) DEFAULT NULL::character varying,
    cadence_minutes integer DEFAULT 5,
    caps json,
    chat_id character varying(255) DEFAULT NULL::character varying,
    created_at timestamp with time zone,
    created_from_chat_id character varying(255) DEFAULT NULL::character varying,
    expires_at timestamp with time zone NOT NULL,
    failure_count integer DEFAULT 0,
    id uuid NOT NULL,
    name character varying(255) DEFAULT NULL::character varying,
    popcorn_state json,
    project_id uuid,
    report_id bigint,
    status character varying(255) DEFAULT 'active'::character varying,
    updated_at timestamp with time zone
);


--
-- Name: agent_loop_run; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_loop_run (
    detail text,
    finished_at timestamp with time zone,
    generation_id uuid,
    id uuid NOT NULL,
    loop_id uuid,
    started_at timestamp with time zone,
    status character varying(255) DEFAULT NULL::character varying
);


--
-- Name: agent_memory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_memory (
    content text,
    created_at timestamp with time zone,
    directus_user_id character varying(255) DEFAULT NULL::character varying,
    id uuid NOT NULL,
    memory_key character varying(255) DEFAULT NULL::character varying,
    project_id character varying(255) DEFAULT NULL::character varying,
    scope character varying(255) DEFAULT 'project'::character varying,
    source character varying(255) DEFAULT 'agent'::character varying,
    updated_at timestamp with time zone,
    workspace_id character varying(255) DEFAULT NULL::character varying
);


--
-- Name: agent_token; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_token (
    created_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    grant_id uuid NOT NULL,
    id uuid NOT NULL,
    kind character varying(255) DEFAULT NULL::character varying NOT NULL,
    pair_id uuid NOT NULL,
    revoked_at timestamp with time zone,
    token_hash character varying(255) DEFAULT NULL::character varying NOT NULL
);


--
-- Name: analysis_feedback; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analysis_feedback (
    actor_id character varying(64) DEFAULT NULL::character varying NOT NULL,
    created_at timestamp with time zone,
    id uuid NOT NULL,
    note text,
    object_id uuid NOT NULL,
    project_id uuid NOT NULL,
    rating character varying(8) DEFAULT NULL::character varying NOT NULL,
    revision_id uuid NOT NULL,
    tags json NOT NULL,
    updated_at timestamp with time zone,
    CONSTRAINT analysis_feedback_actor_present CHECK ((length(btrim((actor_id)::text)) > 0)),
    CONSTRAINT analysis_feedback_note_length CHECK (((note IS NULL) OR (length(note) <= 500))),
    CONSTRAINT analysis_feedback_rating_valid CHECK (((rating)::text = ANY (ARRAY[('up'::character varying)::text, ('down'::character varying)::text]))),
    CONSTRAINT analysis_feedback_tags_are_an_array CHECK ((json_typeof(tags) = 'array'::text))
);


--
-- Name: analysis_last_opened; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analysis_last_opened (
    id uuid NOT NULL,
    opened_at timestamp with time zone NOT NULL,
    project_id uuid NOT NULL,
    user_id character varying(64) DEFAULT NULL::character varying NOT NULL,
    CONSTRAINT analysis_last_opened_user_present CHECK ((length(btrim((user_id)::text)) > 0))
);


--
-- Name: analysis_object; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analysis_object (
    created_at timestamp with time zone,
    current_revision_id uuid,
    id uuid NOT NULL,
    lineage_key character varying(255) DEFAULT NULL::character varying NOT NULL,
    project_id uuid NOT NULL,
    revision_count integer DEFAULT 0 NOT NULL,
    scope_id uuid,
    type character varying(64) DEFAULT NULL::character varying NOT NULL,
    updated_at timestamp with time zone,
    CONSTRAINT analysis_object_revision_count_valid CHECK ((revision_count >= 0))
);


--
-- Name: analysis_object_revision; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analysis_object_revision (
    actor_id character varying(64) DEFAULT NULL::character varying,
    attributes json,
    change_kind character varying(16) DEFAULT NULL::character varying,
    content_hash character varying(64) DEFAULT NULL::character varying NOT NULL,
    created_at timestamp with time zone,
    embedding_refs json,
    hash_version character varying(16) DEFAULT 'c14n-v1'::character varying NOT NULL,
    id uuid NOT NULL,
    object_id uuid NOT NULL,
    origin character varying(16) DEFAULT NULL::character varying NOT NULL,
    parent_revision_id uuid,
    payload json NOT NULL,
    project_id uuid NOT NULL,
    provenance json NOT NULL,
    published_at timestamp with time zone,
    reason text,
    revision_number integer NOT NULL,
    run_id uuid,
    schema_version integer NOT NULL,
    status character varying(16) DEFAULT NULL::character varying NOT NULL,
    type character varying(64) DEFAULT NULL::character varying NOT NULL,
    CONSTRAINT analysis_object_revision_change_kind_authored CHECK (((change_kind IS NULL) OR ((origin)::text = 'authored'::text))),
    CONSTRAINT analysis_object_revision_change_kind_valid CHECK (((change_kind IS NULL) OR ((change_kind)::text = ANY (ARRAY[('typo'::character varying)::text, ('clarity'::character varying)::text, ('meaning'::character varying)::text, ('withdraw'::character varying)::text, ('restore'::character varying)::text, ('rollback'::character varying)::text])))),
    CONSTRAINT analysis_object_revision_generated_provenance CHECK ((((origin)::text <> 'generated'::text) OR ((((provenance)::jsonb ->> 'runId'::text) IS NOT NULL) AND (((provenance)::jsonb ->> 'recipeId'::text) IS NOT NULL)))),
    CONSTRAINT analysis_object_revision_hash_version_valid CHECK (((hash_version)::text = 'c14n-v1'::text)),
    CONSTRAINT analysis_object_revision_numbers_valid CHECK (((revision_number >= 1) AND (schema_version >= 1))),
    CONSTRAINT analysis_object_revision_origin_valid CHECK (((origin)::text = ANY (ARRAY[('generated'::character varying)::text, ('authored'::character varying)::text, ('imported'::character varying)::text]))),
    CONSTRAINT analysis_object_revision_published_at CHECK ((((status)::text <> 'published'::text) OR (published_at IS NOT NULL))),
    CONSTRAINT analysis_object_revision_status_valid CHECK (((status)::text = ANY (ARRAY[('staged'::character varying)::text, ('candidate'::character varying)::text, ('published'::character varying)::text, ('discarded'::character varying)::text])))
);


--
-- Name: analysis_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analysis_outbox (
    attempts integer DEFAULT 0 NOT NULL,
    claim character varying(64) DEFAULT NULL::character varying,
    consumers json,
    created_at timestamp with time zone,
    delivered_at timestamp with time zone,
    event_type character varying(64) DEFAULT NULL::character varying NOT NULL,
    id uuid NOT NULL,
    last_error text,
    next_attempt_at timestamp with time zone,
    payload json,
    project_id uuid NOT NULL,
    run_id uuid,
    scope_id uuid NOT NULL,
    sequence integer NOT NULL,
    snapshot_id uuid,
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    updated_at timestamp with time zone,
    CONSTRAINT analysis_outbox_counters_valid CHECK (((sequence >= 1) AND (attempts >= 0))),
    CONSTRAINT analysis_outbox_status_valid CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('dispatching'::character varying)::text, ('delivered'::character varying)::text, ('dead'::character varying)::text])))
);


--
-- Name: analysis_relation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analysis_relation (
    attributes json,
    basis character varying(16) DEFAULT NULL::character varying NOT NULL,
    content_hash character varying(64) DEFAULT NULL::character varying NOT NULL,
    created_at timestamp with time zone,
    from_object_id uuid NOT NULL,
    from_revision_id uuid NOT NULL,
    hash_version character varying(16) DEFAULT 'c14n-v1'::character varying NOT NULL,
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    provenance json,
    published_at timestamp with time zone,
    run_id uuid,
    status character varying(16) DEFAULT NULL::character varying NOT NULL,
    to_object_id uuid NOT NULL,
    to_revision_id uuid NOT NULL,
    type character varying(64) DEFAULT NULL::character varying NOT NULL,
    CONSTRAINT analysis_relation_basis_valid CHECK (((basis)::text = ANY (ARRAY[('extracted'::character varying)::text, ('inferred'::character varying)::text, ('authored'::character varying)::text]))),
    CONSTRAINT analysis_relation_hash_version_valid CHECK (((hash_version)::text = 'c14n-v1'::text)),
    CONSTRAINT analysis_relation_not_reflexive CHECK ((from_revision_id <> to_revision_id)),
    CONSTRAINT analysis_relation_status_valid CHECK (((status)::text = ANY (ARRAY[('staged'::character varying)::text, ('published'::character varying)::text, ('discarded'::character varying)::text])))
);


--
-- Name: analysis_request_key; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analysis_request_key (
    created_at timestamp with time zone,
    id uuid NOT NULL,
    idempotency_key character varying(255) DEFAULT NULL::character varying NOT NULL,
    mode character varying(16) DEFAULT NULL::character varying NOT NULL,
    project_id uuid NOT NULL,
    run_id uuid NOT NULL,
    scope_id uuid NOT NULL,
    CONSTRAINT analysis_request_key_mode_valid CHECK (((mode)::text = ANY (ARRAY[('refresh'::character varying)::text, ('regenerate'::character varying)::text, ('retry'::character varying)::text])))
);


--
-- Name: analysis_run; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analysis_run (
    attempt integer DEFAULT 0 NOT NULL,
    checks json,
    completed_at timestamp with time zone,
    context json,
    created_at timestamp with time zone,
    definition json NOT NULL,
    depends_on json,
    epoch integer DEFAULT 0 NOT NULL,
    error text,
    execution_ref character varying(128) DEFAULT NULL::character varying,
    hash_version character varying(16) DEFAULT 'c14n-v1'::character varying NOT NULL,
    id uuid NOT NULL,
    idempotency_key character varying(255) DEFAULT NULL::character varying NOT NULL,
    input_fingerprint character varying(64) DEFAULT NULL::character varying,
    input_manifest json,
    lease character varying(64) DEFAULT NULL::character varying,
    lease_expires_at timestamp with time zone,
    metrics json,
    mode character varying(16) DEFAULT NULL::character varying NOT NULL,
    output_manifest json,
    parameters json,
    progress json,
    project_id uuid NOT NULL,
    recipe_id character varying(128) DEFAULT NULL::character varying NOT NULL,
    recipe_version character varying(64) DEFAULT NULL::character varying NOT NULL,
    request_fingerprint character varying(64) DEFAULT NULL::character varying NOT NULL,
    request_order integer NOT NULL,
    requested_by character varying(64) DEFAULT NULL::character varying,
    reused_run_id uuid,
    scope_id uuid NOT NULL,
    started_at timestamp with time zone,
    status character varying(32) DEFAULT NULL::character varying NOT NULL,
    updated_at timestamp with time zone,
    writer_fence integer DEFAULT 0 NOT NULL,
    CONSTRAINT analysis_run_counters_valid CHECK (((request_order >= 1) AND (epoch >= 0) AND (attempt >= 0))),
    CONSTRAINT analysis_run_hash_version_valid CHECK (((hash_version)::text = 'c14n-v1'::text)),
    CONSTRAINT analysis_run_mode_valid CHECK (((mode)::text = ANY (ARRAY[('refresh'::character varying)::text, ('regenerate'::character varying)::text, ('retry'::character varying)::text]))),
    CONSTRAINT analysis_run_ready_has_manifest CHECK ((((status)::text <> 'ready'::text) OR (output_manifest IS NOT NULL))),
    CONSTRAINT analysis_run_running_has_lease CHECK ((((status)::text <> 'running'::text) OR ((lease IS NOT NULL) AND (lease_expires_at IS NOT NULL)))),
    CONSTRAINT analysis_run_status_valid CHECK (((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('waiting_for_inputs'::character varying)::text, ('running'::character varying)::text, ('needs_review'::character varying)::text, ('ready'::character varying)::text, ('failed'::character varying)::text, ('cancelled'::character varying)::text, ('superseded'::character varying)::text]))),
    CONSTRAINT analysis_run_writer_fence_valid CHECK ((writer_fence >= 0))
);


--
-- Name: analysis_scope; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analysis_scope (
    created_at timestamp with time zone,
    current_request_order integer,
    current_run_id uuid,
    current_snapshot_id uuid,
    generation_epoch integer DEFAULT 0 NOT NULL,
    id uuid NOT NULL,
    kind character varying(16) DEFAULT NULL::character varying NOT NULL,
    next_request_order integer DEFAULT 1 NOT NULL,
    project_id uuid NOT NULL,
    publication_sequence integer DEFAULT 0 NOT NULL,
    recipe_id character varying(128) DEFAULT NULL::character varying,
    scope_key character varying(255) DEFAULT NULL::character varying NOT NULL,
    updated_at timestamp with time zone,
    view_id character varying(128) DEFAULT NULL::character varying,
    writer character varying(16) DEFAULT 'analysis'::character varying NOT NULL,
    writer_fence integer DEFAULT 0 NOT NULL,
    CONSTRAINT analysis_scope_counters_valid CHECK (((next_request_order >= 1) AND (generation_epoch >= 0) AND (publication_sequence >= 0) AND (writer_fence >= 0) AND ((current_request_order IS NULL) OR (current_request_order >= 1)))),
    CONSTRAINT analysis_scope_kind_valid CHECK (((((kind)::text = 'producer'::text) AND (recipe_id IS NOT NULL) AND (view_id IS NULL) AND (current_snapshot_id IS NULL)) OR (((kind)::text = 'view'::text) AND (view_id IS NOT NULL) AND (recipe_id IS NULL) AND (current_run_id IS NULL)))),
    CONSTRAINT analysis_scope_writer_valid CHECK (((writer)::text = ANY (ARRAY[('legacy'::character varying)::text, ('analysis'::character varying)::text])))
);


--
-- Name: analysis_snapshot; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analysis_snapshot (
    content_hash character varying(64) DEFAULT NULL::character varying NOT NULL,
    created_at timestamp with time zone,
    created_by character varying(64) DEFAULT NULL::character varying,
    embedding_config json,
    hash_version character varying(16) DEFAULT 'c14n-v1'::character varying NOT NULL,
    id uuid NOT NULL,
    manifest json NOT NULL,
    manifest_version integer DEFAULT 1 NOT NULL,
    parent_snapshot_id uuid,
    project_id uuid NOT NULL,
    scope_id uuid NOT NULL,
    settings json,
    source_event_id uuid,
    versions json,
    view_id character varying(128) DEFAULT NULL::character varying NOT NULL,
    CONSTRAINT analysis_snapshot_hash_version_valid CHECK (((hash_version)::text = 'c14n-v1'::text)),
    CONSTRAINT analysis_snapshot_manifest_version_valid CHECK ((manifest_version >= 1))
);


--
-- Name: analysis_step; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analysis_step (
    attempt integer DEFAULT 1 NOT NULL,
    cache_key character varying(64) DEFAULT NULL::character varying NOT NULL,
    checkpoint json,
    completed_at timestamp with time zone,
    created_at timestamp with time zone,
    error text,
    hash_version character varying(16) DEFAULT 'c14n-v1'::character varying NOT NULL,
    id uuid NOT NULL,
    kind character varying(16) DEFAULT NULL::character varying NOT NULL,
    lease character varying(64) DEFAULT NULL::character varying,
    output json,
    project_id uuid NOT NULL,
    reused_step_id uuid,
    run_id uuid NOT NULL,
    status character varying(16) DEFAULT NULL::character varying NOT NULL,
    step_key character varying(128) DEFAULT NULL::character varying NOT NULL,
    step_version character varying(64) DEFAULT NULL::character varying NOT NULL,
    updated_at timestamp with time zone,
    usage json,
    validation json,
    CONSTRAINT analysis_step_attempt_valid CHECK ((attempt >= 1)),
    CONSTRAINT analysis_step_hash_version_valid CHECK (((hash_version)::text = 'c14n-v1'::text)),
    CONSTRAINT analysis_step_kind_valid CHECK (((kind)::text = ANY (ARRAY[('model'::character varying)::text, ('deterministic'::character varying)::text, ('check'::character varying)::text]))),
    CONSTRAINT analysis_step_status_valid CHECK (((status)::text = ANY (ARRAY[('running'::character varying)::text, ('completed'::character varying)::text, ('failed'::character varying)::text])))
);


--
-- Name: announcement; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.announcement (
    created_at timestamp with time zone,
    expires_at timestamp without time zone,
    id uuid NOT NULL,
    level character varying(255) DEFAULT NULL::character varying,
    sort integer,
    updated_at timestamp with time zone,
    user_created uuid,
    user_updated uuid
);


--
-- Name: announcement_activity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.announcement_activity (
    announcement_activity uuid,
    created_at timestamp with time zone,
    id uuid NOT NULL,
    read boolean DEFAULT false,
    sort integer,
    updated_at timestamp with time zone,
    user_created uuid,
    user_id uuid,
    user_updated uuid
);


--
-- Name: announcement_translations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.announcement_translations (
    announcement_id uuid,
    id integer NOT NULL,
    languages_code character varying(255) DEFAULT NULL::character varying,
    message text,
    title text
);


--
-- Name: announcement_translations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.announcement_translations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: announcement_translations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.announcement_translations_id_seq OWNED BY public.announcement_translations.id;


--
-- Name: app_user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_user (
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    directus_user_id uuid,
    display_name character varying(255) DEFAULT NULL::character varying,
    email character varying(255) DEFAULT NULL::character varying,
    id uuid NOT NULL,
    onboarding_answer_json json,
    settings json,
    terms_accepted_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: aspect; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.aspect (
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    description text,
    id uuid NOT NULL,
    image_url character varying(255) DEFAULT NULL::character varying,
    long_summary text,
    name character varying(255) DEFAULT NULL::character varying,
    short_summary text,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    view_id uuid
);


--
-- Name: aspect_segment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.aspect_segment (
    aspect uuid,
    description text,
    id uuid NOT NULL,
    relevant_index text,
    segment integer,
    verbatim_transcript text
);


--
-- Name: billing_account; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_account (
    account_manager_id uuid,
    billing_address_line1 character varying(255) DEFAULT NULL::character varying,
    billing_address_line2 character varying(255) DEFAULT NULL::character varying,
    billing_city character varying(255) DEFAULT NULL::character varying,
    billing_country character varying(255) DEFAULT NULL::character varying,
    billing_legal_name character varying(255) DEFAULT NULL::character varying,
    billing_period character varying(255) DEFAULT NULL::character varying,
    billing_postal_code character varying(255) DEFAULT NULL::character varying,
    billing_vat_id character varying(255) DEFAULT NULL::character varying,
    billing_vat_region character varying(255) DEFAULT NULL::character varying,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    created_by uuid,
    deleted_at timestamp with time zone,
    downgraded_at timestamp with time zone,
    downgraded_from_tier character varying(255) DEFAULT NULL::character varying,
    id uuid NOT NULL,
    label character varying(255) DEFAULT NULL::character varying,
    mollie_customer_id character varying(255) DEFAULT NULL::character varying,
    mollie_subscription_id character varying(255) DEFAULT NULL::character varying,
    org_id uuid,
    payment_failed_notified boolean DEFAULT false NOT NULL,
    payment_mode character varying(255) DEFAULT 'none'::character varying NOT NULL,
    percent_discount integer,
    pre_warning_sent boolean DEFAULT false NOT NULL,
    provisioned_seats integer,
    reconcile_failed_at timestamp with time zone,
    status character varying(255) DEFAULT 'none'::character varying,
    tier character varying(255) DEFAULT 'free'::character varying NOT NULL,
    tier_expires_at timestamp with time zone,
    type_discount character varying(255) DEFAULT NULL::character varying,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    workspace_id uuid
);


--
-- Name: canvas_config_revision; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.canvas_config_revision (
    brief text,
    cadence_minutes integer DEFAULT 5,
    created_at timestamp with time zone,
    created_by character varying(255) DEFAULT NULL::character varying,
    gather_spec json,
    id uuid NOT NULL,
    note character varying(255) DEFAULT NULL::character varying,
    popcorn_settings json,
    report_id bigint
);


--
-- Name: canvas_generation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.canvas_generation (
    config_revision_id uuid,
    content_html text,
    created_at timestamp with time zone,
    detail text,
    id uuid NOT NULL,
    report_id bigint,
    status character varying(255) DEFAULT 'ok'::character varying,
    tick_kind character varying(255) DEFAULT NULL::character varying
);


--
-- Name: conversation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation (
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamp with time zone,
    duration real,
    id uuid NOT NULL,
    is_all_chunks_transcribed boolean,
    is_anonymized boolean DEFAULT false,
    is_audio_processing_finished boolean DEFAULT false,
    is_finished boolean DEFAULT false,
    is_over_cap boolean DEFAULT false NOT NULL,
    merged_audio_path text,
    merged_transcript text,
    move_history json,
    participant_email character varying(255) DEFAULT NULL::character varying,
    participant_name character varying(255) DEFAULT NULL::character varying,
    participant_user_agent character varying(255) DEFAULT NULL::character varying,
    project_id uuid NOT NULL,
    recording_started_at timestamp with time zone,
    source character varying(255) DEFAULT NULL::character varying,
    summary text,
    title text,
    token_count integer,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: conversation_artifact; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_artifact (
    approved_at timestamp with time zone,
    content text,
    conversation_id uuid,
    date_created timestamp with time zone,
    id uuid NOT NULL,
    key character varying(255) DEFAULT NULL::character varying,
    last_updated_at timestamp without time zone,
    read_aloud_stream_url text,
    topic_label character varying(255) DEFAULT NULL::character varying,
    user_created uuid,
    user_updated uuid
);


--
-- Name: conversation_chunk; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_chunk (
    conversation_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    cross_talk_instances integer DEFAULT 0,
    desired_language character varying(255) DEFAULT NULL::character varying,
    detected_language character varying(255) DEFAULT NULL::character varying,
    detected_language_confidence real,
    diarization json,
    error text,
    hallucination_reason text,
    hallucination_score real,
    id uuid NOT NULL,
    noise_ratio real DEFAULT '0'::real,
    path character varying(255) DEFAULT NULL::character varying,
    raw_transcript text,
    runpod_job_status_link text,
    runpod_request_count integer DEFAULT 0,
    silence_ratio real DEFAULT '0'::real,
    source character varying(255) DEFAULT NULL::character varying,
    "timestamp" timestamp with time zone NOT NULL,
    transcript text,
    translation_error character varying(255) DEFAULT NULL::character varying,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: conversation_link; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_link (
    date_created timestamp with time zone,
    date_updated timestamp with time zone,
    id bigint NOT NULL,
    link_type character varying(255) DEFAULT NULL::character varying,
    source_conversation_id uuid,
    target_conversation_id uuid
);


--
-- Name: conversation_link_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.conversation_link_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: conversation_link_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.conversation_link_id_seq OWNED BY public.conversation_link.id;


--
-- Name: conversation_project_tag; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_project_tag (
    conversation_id uuid,
    id integer NOT NULL,
    project_tag_id uuid
);


--
-- Name: conversation_project_tag_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.conversation_project_tag_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: conversation_project_tag_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.conversation_project_tag_id_seq OWNED BY public.conversation_project_tag.id;


--
-- Name: conversation_reply; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_reply (
    content_text text,
    conversation_id character varying(255) DEFAULT NULL::character varying,
    date_created timestamp with time zone,
    id uuid NOT NULL,
    reply uuid,
    sort integer,
    type character varying(255) DEFAULT NULL::character varying
);


--
-- Name: conversation_segment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_segment (
    config_id character varying(255) DEFAULT NULL::character varying,
    contextual_transcript text,
    conversation_id uuid,
    counter real,
    id integer NOT NULL,
    lightrag_flag boolean DEFAULT false,
    path text,
    transcript text
);


--
-- Name: conversation_segment_conversation_chunk; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_segment_conversation_chunk (
    conversation_chunk_id uuid,
    conversation_segment_id integer,
    id integer NOT NULL
);


--
-- Name: conversation_segment_conversation_chunk_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.conversation_segment_conversation_chunk_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: conversation_segment_conversation_chunk_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.conversation_segment_conversation_chunk_id_seq OWNED BY public.conversation_segment_conversation_chunk.id;


--
-- Name: conversation_segment_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.conversation_segment_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: conversation_segment_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.conversation_segment_id_seq OWNED BY public.conversation_segment.id;


--
-- Name: directus_access; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_access (
    id uuid NOT NULL,
    role uuid,
    "user" uuid,
    policy uuid NOT NULL,
    sort integer
);


--
-- Name: directus_activity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_activity (
    id integer NOT NULL,
    action character varying(45) NOT NULL,
    "user" uuid,
    "timestamp" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    ip character varying(50),
    user_agent text,
    collection character varying(64) NOT NULL,
    item character varying(255) NOT NULL,
    origin character varying(255)
);


--
-- Name: directus_activity_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.directus_activity_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: directus_activity_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.directus_activity_id_seq OWNED BY public.directus_activity.id;


--
-- Name: directus_collections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_collections (
    collection character varying(64) NOT NULL,
    icon character varying(64),
    note text,
    display_template character varying(255),
    hidden boolean DEFAULT false NOT NULL,
    singleton boolean DEFAULT false NOT NULL,
    translations json,
    archive_field character varying(64),
    archive_app_filter boolean DEFAULT true NOT NULL,
    archive_value character varying(255),
    unarchive_value character varying(255),
    sort_field character varying(64),
    accountability character varying(255) DEFAULT 'all'::character varying,
    color character varying(255),
    item_duplication_fields json,
    sort integer,
    "group" character varying(64),
    collapse character varying(255) DEFAULT 'open'::character varying NOT NULL,
    preview_url character varying(255),
    versioning boolean DEFAULT false NOT NULL
);


--
-- Name: directus_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_comments (
    id uuid NOT NULL,
    collection character varying(64) NOT NULL,
    item character varying(255) NOT NULL,
    comment text NOT NULL,
    date_created timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    date_updated timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    user_created uuid,
    user_updated uuid
);


--
-- Name: directus_dashboards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_dashboards (
    id uuid NOT NULL,
    name character varying(255) NOT NULL,
    icon character varying(64) DEFAULT 'dashboard'::character varying NOT NULL,
    note text,
    date_created timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    user_created uuid,
    color character varying(255)
);


--
-- Name: directus_extensions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_extensions (
    enabled boolean DEFAULT true NOT NULL,
    id uuid NOT NULL,
    folder character varying(255) NOT NULL,
    source character varying(255) NOT NULL,
    bundle uuid
);


--
-- Name: directus_fields; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_fields (
    id integer NOT NULL,
    collection character varying(64) NOT NULL,
    field character varying(64) NOT NULL,
    special character varying(64),
    interface character varying(64),
    options json,
    display character varying(64),
    display_options json,
    readonly boolean DEFAULT false NOT NULL,
    hidden boolean DEFAULT false NOT NULL,
    sort integer,
    width character varying(30) DEFAULT 'full'::character varying,
    translations json,
    note text,
    conditions json,
    required boolean DEFAULT false,
    "group" character varying(64),
    validation json,
    validation_message text,
    searchable boolean DEFAULT true NOT NULL
);


--
-- Name: directus_fields_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.directus_fields_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: directus_fields_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.directus_fields_id_seq OWNED BY public.directus_fields.id;


--
-- Name: directus_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_files (
    id uuid NOT NULL,
    storage character varying(255) NOT NULL,
    filename_disk character varying(255),
    filename_download character varying(255) NOT NULL,
    title character varying(255),
    type character varying(255),
    folder uuid,
    uploaded_by uuid,
    created_on timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    modified_by uuid,
    modified_on timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    charset character varying(50),
    filesize bigint,
    width integer,
    height integer,
    duration integer,
    embed character varying(200),
    description text,
    location text,
    tags text,
    metadata json,
    focal_point_x integer,
    focal_point_y integer,
    tus_id character varying(64),
    tus_data json,
    uploaded_on timestamp with time zone
);


--
-- Name: directus_flows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_flows (
    id uuid NOT NULL,
    name character varying(255) NOT NULL,
    icon character varying(64),
    color character varying(255),
    description text,
    status character varying(255) DEFAULT 'active'::character varying NOT NULL,
    trigger character varying(255),
    accountability character varying(255) DEFAULT 'all'::character varying,
    options json,
    operation uuid,
    date_created timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    user_created uuid
);


--
-- Name: directus_folders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_folders (
    id uuid NOT NULL,
    name character varying(255) NOT NULL,
    parent uuid
);


--
-- Name: directus_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_migrations (
    version character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    "timestamp" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: directus_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_notifications (
    id integer NOT NULL,
    "timestamp" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    status character varying(255) DEFAULT 'inbox'::character varying,
    recipient uuid NOT NULL,
    sender uuid,
    subject character varying(255) NOT NULL,
    message text,
    collection character varying(64),
    item character varying(255)
);


--
-- Name: directus_notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.directus_notifications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: directus_notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.directus_notifications_id_seq OWNED BY public.directus_notifications.id;


--
-- Name: directus_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_operations (
    id uuid NOT NULL,
    name character varying(255),
    key character varying(255) NOT NULL,
    type character varying(255) NOT NULL,
    position_x integer NOT NULL,
    position_y integer NOT NULL,
    options json,
    resolve uuid,
    reject uuid,
    flow uuid NOT NULL,
    date_created timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    user_created uuid
);


--
-- Name: directus_panels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_panels (
    id uuid NOT NULL,
    dashboard uuid NOT NULL,
    name character varying(255),
    icon character varying(64) DEFAULT NULL::character varying,
    color character varying(10),
    show_header boolean DEFAULT false NOT NULL,
    note text,
    type character varying(255) NOT NULL,
    position_x integer NOT NULL,
    position_y integer NOT NULL,
    width integer NOT NULL,
    height integer NOT NULL,
    options json,
    date_created timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    user_created uuid
);


--
-- Name: directus_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_permissions (
    id integer NOT NULL,
    collection character varying(64) NOT NULL,
    action character varying(10) NOT NULL,
    permissions json,
    validation json,
    presets json,
    fields text,
    policy uuid NOT NULL
);


--
-- Name: directus_permissions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.directus_permissions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: directus_permissions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.directus_permissions_id_seq OWNED BY public.directus_permissions.id;


--
-- Name: directus_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_policies (
    id uuid NOT NULL,
    name character varying(100) NOT NULL,
    icon character varying(64) DEFAULT 'badge'::character varying NOT NULL,
    description text,
    ip_access text,
    enforce_tfa boolean DEFAULT false NOT NULL,
    admin_access boolean DEFAULT false NOT NULL,
    app_access boolean DEFAULT false NOT NULL
);


--
-- Name: directus_presets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_presets (
    id integer NOT NULL,
    bookmark character varying(255),
    "user" uuid,
    role uuid,
    collection character varying(64),
    search character varying(100),
    layout character varying(100) DEFAULT 'tabular'::character varying,
    layout_query json,
    layout_options json,
    refresh_interval integer,
    filter json,
    icon character varying(64) DEFAULT 'bookmark'::character varying,
    color character varying(255)
);


--
-- Name: directus_presets_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.directus_presets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: directus_presets_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.directus_presets_id_seq OWNED BY public.directus_presets.id;


--
-- Name: directus_relations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_relations (
    id integer NOT NULL,
    many_collection character varying(64) NOT NULL,
    many_field character varying(64) NOT NULL,
    one_collection character varying(64),
    one_field character varying(64),
    one_collection_field character varying(64),
    one_allowed_collections text,
    junction_field character varying(64),
    sort_field character varying(64),
    one_deselect_action character varying(255) DEFAULT 'nullify'::character varying NOT NULL
);


--
-- Name: directus_relations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.directus_relations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: directus_relations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.directus_relations_id_seq OWNED BY public.directus_relations.id;


--
-- Name: directus_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_revisions (
    id integer NOT NULL,
    activity integer NOT NULL,
    collection character varying(64) NOT NULL,
    item character varying(255) NOT NULL,
    data json,
    delta json,
    parent integer,
    version uuid
);


--
-- Name: directus_revisions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.directus_revisions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: directus_revisions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.directus_revisions_id_seq OWNED BY public.directus_revisions.id;


--
-- Name: directus_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_roles (
    id uuid NOT NULL,
    name character varying(100) NOT NULL,
    icon character varying(64) DEFAULT 'supervised_user_circle'::character varying NOT NULL,
    description text,
    parent uuid
);


--
-- Name: directus_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_sessions (
    token character varying(64) NOT NULL,
    "user" uuid,
    expires timestamp with time zone NOT NULL,
    ip character varying(255),
    user_agent text,
    share uuid,
    origin character varying(255),
    next_token character varying(64)
);


--
-- Name: directus_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_settings (
    id integer NOT NULL,
    project_name character varying(100) DEFAULT 'Directus'::character varying NOT NULL,
    project_url character varying(255),
    project_color character varying(255) DEFAULT '#6644FF'::character varying NOT NULL,
    project_logo uuid,
    public_foreground uuid,
    public_background uuid,
    public_note text,
    auth_login_attempts integer DEFAULT 25,
    auth_password_policy character varying(100),
    storage_asset_transform character varying(7) DEFAULT 'all'::character varying,
    storage_asset_presets json,
    custom_css text,
    storage_default_folder uuid,
    basemaps json,
    mapbox_key character varying(255),
    module_bar json,
    project_descriptor character varying(100),
    default_language character varying(255) DEFAULT 'en-US'::character varying NOT NULL,
    custom_aspect_ratios json,
    public_favicon uuid,
    default_appearance character varying(255) DEFAULT 'auto'::character varying NOT NULL,
    default_theme_light character varying(255),
    theme_light_overrides json,
    default_theme_dark character varying(255),
    theme_dark_overrides json,
    report_error_url character varying(255),
    report_bug_url character varying(255),
    report_feature_url character varying(255),
    public_registration boolean DEFAULT false NOT NULL,
    public_registration_verify_email boolean DEFAULT true NOT NULL,
    public_registration_role uuid,
    public_registration_email_filter json,
    visual_editor_urls json,
    project_id uuid,
    mcp_enabled boolean DEFAULT false NOT NULL,
    mcp_allow_deletes boolean DEFAULT false NOT NULL,
    mcp_prompts_collection character varying(255) DEFAULT NULL::character varying,
    mcp_system_prompt_enabled boolean DEFAULT true NOT NULL,
    mcp_system_prompt text,
    project_owner character varying(255),
    project_usage character varying(255),
    org_name character varying(255),
    product_updates boolean,
    project_status character varying(255)
);


--
-- Name: directus_settings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.directus_settings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: directus_settings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.directus_settings_id_seq OWNED BY public.directus_settings.id;


--
-- Name: directus_shares; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_shares (
    id uuid NOT NULL,
    name character varying(255),
    collection character varying(64) NOT NULL,
    item character varying(255) NOT NULL,
    role uuid,
    password character varying(255),
    user_created uuid,
    date_created timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    date_start timestamp with time zone,
    date_end timestamp with time zone,
    times_used integer DEFAULT 0,
    max_uses integer
);


--
-- Name: directus_sync_id_map; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_sync_id_map (
    id integer NOT NULL,
    "table" character varying(255) NOT NULL,
    sync_id character varying(255) NOT NULL,
    local_id character varying(255) NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: directus_sync_id_map_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.directus_sync_id_map_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: directus_sync_id_map_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.directus_sync_id_map_id_seq OWNED BY public.directus_sync_id_map.id;


--
-- Name: directus_translations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_translations (
    id uuid NOT NULL,
    language character varying(255) NOT NULL,
    key character varying(255) NOT NULL,
    value text NOT NULL
);


--
-- Name: directus_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_users (
    id uuid NOT NULL,
    first_name character varying(50),
    last_name character varying(50),
    email character varying(128),
    password character varying(255),
    location character varying(255),
    title character varying(50),
    description text,
    tags json,
    avatar uuid,
    language character varying(255) DEFAULT NULL::character varying,
    tfa_secret character varying(255),
    status character varying(16) DEFAULT 'active'::character varying NOT NULL,
    role uuid,
    token character varying(255),
    last_access timestamp with time zone,
    last_page character varying(255),
    provider character varying(128) DEFAULT 'default'::character varying NOT NULL,
    external_identifier character varying(255),
    auth_data json,
    email_notifications boolean DEFAULT true,
    appearance character varying(255),
    theme_dark character varying(255),
    theme_light character varying(255),
    theme_light_overrides json,
    theme_dark_overrides json,
    text_direction character varying(255) DEFAULT 'auto'::character varying NOT NULL,
    disable_create_project boolean DEFAULT false,
    hide_ai_suggestions boolean DEFAULT false,
    legal_basis character varying(255) DEFAULT 'client-managed'::character varying,
    privacy_policy_url character varying(255) DEFAULT NULL::character varying,
    quick_access_preferences json DEFAULT '[]'::json,
    whitelabel_logo uuid
);


--
-- Name: directus_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_versions (
    id uuid NOT NULL,
    key character varying(64) NOT NULL,
    name character varying(255),
    collection character varying(64) NOT NULL,
    item character varying(255) NOT NULL,
    hash character varying(255),
    date_created timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    date_updated timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    user_created uuid,
    user_updated uuid,
    delta json
);


--
-- Name: directus_webhooks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_webhooks (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    method character varying(10) DEFAULT 'POST'::character varying NOT NULL,
    url character varying(255) NOT NULL,
    status character varying(10) DEFAULT 'active'::character varying NOT NULL,
    data boolean DEFAULT true NOT NULL,
    actions character varying(100) NOT NULL,
    collections character varying(255) NOT NULL,
    headers json,
    was_active_before_deprecation boolean DEFAULT false NOT NULL,
    migrated_flow uuid
);


--
-- Name: directus_webhooks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.directus_webhooks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: directus_webhooks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.directus_webhooks_id_seq OWNED BY public.directus_webhooks.id;


--
-- Name: insight; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.insight (
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    id uuid NOT NULL,
    project_analysis_run_id uuid,
    summary text,
    title text,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: languages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.languages (
    code character varying(255) DEFAULT NULL::character varying NOT NULL,
    direction character varying(255) DEFAULT 'ltr'::character varying,
    name character varying(255) DEFAULT NULL::character varying
);


--
-- Name: map_embedding; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.map_embedding (
    config_key character varying(64) DEFAULT NULL::character varying NOT NULL,
    created_at timestamp with time zone,
    dims integer NOT NULL,
    id uuid NOT NULL,
    input_hash character varying(64) DEFAULT NULL::character varying NOT NULL,
    model character varying(255) DEFAULT NULL::character varying NOT NULL,
    project_id uuid NOT NULL,
    embedding public.vector NOT NULL,
    CONSTRAINT map_embedding_dims_match CHECK (((dims > 0) AND (public.vector_dims(embedding) = dims))),
    CONSTRAINT map_embedding_nonzero CHECK ((public.vector_norm(embedding) > (0)::double precision))
);


--
-- Name: map_fact_check; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.map_fact_check (
    attempt integer DEFAULT 0 NOT NULL,
    claim_key character varying(64) DEFAULT NULL::character varying NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone,
    error text,
    id uuid NOT NULL,
    justification text,
    model character varying(255) DEFAULT NULL::character varying,
    project_id uuid NOT NULL,
    prompt_version character varying(128) DEFAULT NULL::character varying,
    requested_by character varying(64) DEFAULT NULL::character varying,
    sources json,
    started_at timestamp with time zone,
    statement text NOT NULL,
    status character varying(32) DEFAULT NULL::character varying NOT NULL,
    updated_at timestamp with time zone,
    verdict character varying(32) DEFAULT NULL::character varying
);


--
-- Name: map_result; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.map_result (
    completed_at timestamp with time zone,
    created_at timestamp with time zone,
    embedding_config json,
    error text,
    execution_ref character varying(128) DEFAULT NULL::character varying,
    id uuid NOT NULL,
    manifest json,
    manifest_version integer DEFAULT 1 NOT NULL,
    progress json,
    project_id uuid NOT NULL,
    recipe_version character varying(64) DEFAULT NULL::character varying NOT NULL,
    requested_by character varying(64) DEFAULT NULL::character varying,
    snapshot_id uuid,
    source_fingerprint character varying(64) DEFAULT NULL::character varying,
    status character varying(32) DEFAULT NULL::character varying NOT NULL,
    updated_at timestamp with time zone,
    CONSTRAINT map_result_manifest_version_valid CHECK ((manifest_version = ANY (ARRAY[1, 2])))
);


--
-- Name: methodology; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.methodology (
    created_at timestamp with time zone,
    description text,
    framing text,
    id uuid NOT NULL,
    is_seeded boolean DEFAULT false,
    name character varying(255) DEFAULT NULL::character varying NOT NULL,
    owner_directus_user_id character varying(255) DEFAULT NULL::character varying,
    updated_at timestamp with time zone,
    visibility character varying(255) DEFAULT 'private'::character varying,
    workspace_id uuid
);


--
-- Name: methodology_version; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.methodology_version (
    content json NOT NULL,
    created_at timestamp with time zone,
    created_by character varying(255) DEFAULT NULL::character varying,
    id uuid NOT NULL,
    methodology_id uuid,
    note character varying(255) DEFAULT NULL::character varying
);


--
-- Name: model_response_feedback; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.model_response_feedback (
    chat_mode character varying(255) DEFAULT NULL::character varying,
    comment text,
    context json,
    date_created timestamp with time zone,
    date_updated timestamp with time zone,
    id uuid NOT NULL,
    project_id uuid,
    rating character varying(255) DEFAULT NULL::character varying NOT NULL,
    reason character varying(255) DEFAULT NULL::character varying,
    reasons json,
    response_snapshot text,
    target_id character varying(255) DEFAULT NULL::character varying NOT NULL,
    target_type character varying(255) DEFAULT NULL::character varying NOT NULL,
    user_id uuid
);


--
-- Name: notification; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification (
    action character varying(255) DEFAULT 'NONE'::character varying NOT NULL,
    actor_user_id uuid,
    audience_user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    event_code character varying(255) DEFAULT NULL::character varying NOT NULL,
    expires_at timestamp with time zone,
    id uuid NOT NULL,
    message text,
    params json,
    read_at timestamp with time zone,
    ref_chat_id uuid,
    ref_conversation_id uuid,
    ref_invite_id uuid,
    ref_org_id uuid,
    ref_project_id uuid,
    ref_report_id character varying(255) DEFAULT NULL::character varying,
    ref_workspace_id uuid,
    scope character varying(255) DEFAULT NULL::character varying,
    severity character varying(255) DEFAULT 'info'::character varying NOT NULL,
    title character varying(255) DEFAULT NULL::character varying NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: org; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org (
    agent_access_enabled boolean DEFAULT false NOT NULL,
    agent_access_updated_at timestamp with time zone,
    agent_access_updated_by uuid,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    created_by uuid,
    deleted_at timestamp with time zone,
    description text,
    id uuid NOT NULL,
    is_partner boolean DEFAULT false NOT NULL,
    logo_url character varying(255) DEFAULT NULL::character varying,
    name character varying(255) DEFAULT NULL::character varying NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: org_invite; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_invite (
    accepted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamp with time zone,
    email character varying(255) DEFAULT NULL::character varying NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    id uuid NOT NULL,
    invited_by uuid,
    org_id uuid NOT NULL,
    role character varying(255) DEFAULT 'member'::character varying NOT NULL
);


--
-- Name: org_membership; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_membership (
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    custom_policies json DEFAULT '[]'::json,
    deleted_at timestamp with time zone,
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    role character varying(255) DEFAULT NULL::character varying NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    user_id uuid NOT NULL
);


--
-- Name: pricing_configuration; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pricing_configuration (
    answered_count integer,
    answers_raw json,
    booking_notified_at timestamp with time zone,
    booking_status character varying(255) DEFAULT 'none'::character varying,
    booking_uid character varying(255) DEFAULT NULL::character varying,
    concurrency_bucket character varying(255) DEFAULT NULL::character varying,
    concurrency_exact integer,
    config json,
    config_session_id character varying(255) DEFAULT NULL::character varying NOT NULL,
    config_shape_version integer,
    created_at timestamp with time zone,
    email character varying(255) DEFAULT NULL::character varying,
    furthest_step integer,
    id uuid NOT NULL,
    is_internal boolean DEFAULT false NOT NULL,
    locale character varying(255) DEFAULT NULL::character varying,
    mount character varying(255) DEFAULT 'app'::character varying,
    org_id character varying(255) DEFAULT NULL::character varying,
    project_id character varying(255) DEFAULT NULL::character varying,
    question_set_version character varying(255) DEFAULT NULL::character varying,
    reference character varying(255) DEFAULT NULL::character varying,
    status character varying(255) DEFAULT 'in_progress'::character varying,
    updated_at timestamp with time zone,
    user_id character varying(255) DEFAULT NULL::character varying,
    voice_audio json,
    voice_transcript text,
    volume_bucket character varying(255) DEFAULT NULL::character varying,
    wall_key character varying(255) DEFAULT NULL::character varying,
    workspace_id character varying(255) DEFAULT NULL::character varying
);


--
-- Name: processing_status; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.processing_status (
    conversation_chunk_id uuid,
    conversation_id uuid,
    duration_ms integer,
    event character varying(255) DEFAULT NULL::character varying,
    id bigint NOT NULL,
    message text,
    parent bigint,
    project_analysis_run_id uuid,
    project_id uuid,
    "timestamp" timestamp with time zone
);


--
-- Name: processing_status_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.processing_status_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: processing_status_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.processing_status_id_seq OWNED BY public.processing_status.id;


--
-- Name: project; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project (
    anonymize_transcripts boolean DEFAULT false,
    context text,
    conversation_ask_for_participant_name_label character varying(255) DEFAULT NULL::character varying,
    conversation_title_prompt text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    default_conversation_ask_for_participant_email boolean DEFAULT false,
    default_conversation_ask_for_participant_name boolean DEFAULT true,
    default_conversation_description text,
    default_conversation_finish_text text,
    default_conversation_title character varying(255) DEFAULT NULL::character varying,
    default_conversation_transcript_prompt text,
    default_conversation_tutorial_slug character varying(255) DEFAULT 'none'::character varying,
    deleted_at timestamp with time zone,
    directus_user_id uuid,
    enable_ai_title_and_tags boolean DEFAULT false,
    get_reply_mode character varying(255) DEFAULT 'summarize'::character varying,
    get_reply_prompt text,
    host_guide json,
    id uuid NOT NULL,
    image_generation_model character varying(255) DEFAULT 'PLACEHOLDER'::character varying,
    is_canvas_enabled boolean DEFAULT false,
    is_conversation_allowed boolean NOT NULL,
    is_dembrane_event_cta_enabled boolean DEFAULT true,
    is_enhanced_audio_processing_enabled boolean DEFAULT false,
    is_get_reply_enabled boolean DEFAULT false,
    is_project_notification_subscription_allowed boolean DEFAULT false,
    is_verify_enabled boolean DEFAULT false,
    is_verify_on_finish_enabled boolean DEFAULT false,
    language character varying(255) DEFAULT NULL::character varying,
    legal_basis character varying(255) DEFAULT NULL::character varying,
    methodology_version_id uuid,
    move_history json,
    name character varying(255) DEFAULT NULL::character varying,
    pin_order integer,
    privacy_policy_url character varying(255) DEFAULT NULL::character varying,
    selected_verification_key_list text,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    visibility character varying(255) DEFAULT 'workspace'::character varying NOT NULL,
    workspace_id uuid
);


--
-- Name: project_agentic_run; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_agentic_run (
    agent_thread_id character varying(255) DEFAULT NULL::character varying,
    completed_at timestamp with time zone,
    created_at timestamp with time zone,
    directus_user_id character varying(255) DEFAULT NULL::character varying,
    id uuid NOT NULL,
    last_event_seq integer DEFAULT 0,
    latest_error text,
    latest_error_code character varying(255) DEFAULT NULL::character varying,
    latest_output text,
    project_chat_id uuid,
    project_id uuid,
    started_at timestamp with time zone,
    status character varying(255) DEFAULT 'queued'::character varying,
    updated_at timestamp with time zone
);


--
-- Name: project_agentic_run_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_agentic_run_event (
    event_type character varying(255) DEFAULT NULL::character varying,
    id bigint NOT NULL,
    payload json,
    project_agentic_run_id uuid,
    seq integer,
    "timestamp" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: project_agentic_run_event_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.project_agentic_run_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: project_agentic_run_event_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.project_agentic_run_event_id_seq OWNED BY public.project_agentic_run_event.id;


--
-- Name: project_analysis_run; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_analysis_run (
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    id uuid NOT NULL,
    project_id uuid,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: project_chat; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_chat (
    auto_select boolean DEFAULT true,
    chat_mode character varying(255) DEFAULT NULL::character varying,
    date_created timestamp with time zone,
    date_updated timestamp with time zone,
    deleted_at timestamp with time zone,
    id uuid NOT NULL,
    is_private boolean DEFAULT false,
    name character varying(255) DEFAULT NULL::character varying,
    project_id uuid,
    user_created uuid,
    user_updated uuid
);


--
-- Name: project_chat_conversation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_chat_conversation (
    conversation_id uuid,
    id integer NOT NULL,
    project_chat_id uuid
);


--
-- Name: project_chat_conversation_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.project_chat_conversation_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: project_chat_conversation_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.project_chat_conversation_id_seq OWNED BY public.project_chat_conversation.id;


--
-- Name: project_chat_message; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_chat_message (
    date_created timestamp with time zone,
    date_updated timestamp with time zone,
    id uuid NOT NULL,
    message_from character varying(255) DEFAULT NULL::character varying,
    project_chat_id uuid,
    template_key character varying(255) DEFAULT NULL::character varying,
    text text,
    tokens_count integer
);


--
-- Name: project_chat_message_conversation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_chat_message_conversation (
    conversation_id uuid,
    id integer NOT NULL,
    project_chat_message_id uuid
);


--
-- Name: project_chat_message_conversation_1; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_chat_message_conversation_1 (
    conversation_id uuid,
    id integer NOT NULL,
    project_chat_message_id uuid
);


--
-- Name: project_chat_message_conversation_1_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.project_chat_message_conversation_1_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: project_chat_message_conversation_1_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.project_chat_message_conversation_1_id_seq OWNED BY public.project_chat_message_conversation_1.id;


--
-- Name: project_chat_message_conversation_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.project_chat_message_conversation_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: project_chat_message_conversation_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.project_chat_message_conversation_id_seq OWNED BY public.project_chat_message_conversation.id;


--
-- Name: project_goal_revision; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_goal_revision (
    chat_id character varying(255) DEFAULT NULL::character varying,
    content text NOT NULL,
    created_at timestamp with time zone,
    created_by character varying(255) DEFAULT NULL::character varying,
    id uuid NOT NULL,
    project_id uuid,
    set_by character varying(255) DEFAULT NULL::character varying NOT NULL
);


--
-- Name: project_membership; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_membership (
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    custom_policies json DEFAULT '[]'::json,
    granted_by uuid,
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    user_id uuid NOT NULL
);


--
-- Name: project_report; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_report (
    content text,
    date_created timestamp with time zone,
    date_updated timestamp with time zone,
    deleted_at timestamp with time zone,
    error_code character varying(255) DEFAULT NULL::character varying,
    error_message text,
    id bigint NOT NULL,
    kind character varying(255) DEFAULT 'report'::character varying NOT NULL,
    language character varying(255) DEFAULT NULL::character varying,
    project_id uuid,
    public_token character varying(255) DEFAULT NULL::character varying,
    scheduled_at timestamp with time zone,
    show_portal_link boolean DEFAULT false,
    status character varying(255) DEFAULT 'published'::character varying NOT NULL,
    user_created uuid,
    user_instructions text
);


--
-- Name: project_report_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.project_report_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: project_report_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.project_report_id_seq OWNED BY public.project_report.id;


--
-- Name: project_report_metric; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_report_metric (
    date_created timestamp with time zone,
    date_updated timestamp with time zone,
    id bigint NOT NULL,
    ip character varying(255) DEFAULT NULL::character varying,
    project_report_id bigint,
    type character varying(255) DEFAULT NULL::character varying
);


--
-- Name: project_report_metric_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.project_report_metric_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: project_report_metric_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.project_report_metric_id_seq OWNED BY public.project_report_metric.id;


--
-- Name: project_report_notification_participants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_report_notification_participants (
    conversation_id uuid,
    date_submitted timestamp with time zone,
    date_updated timestamp with time zone,
    email character varying(255) DEFAULT NULL::character varying,
    email_opt_in boolean DEFAULT true,
    email_opt_out_token uuid,
    id uuid NOT NULL,
    project_id character varying(255) DEFAULT NULL::character varying,
    sort integer
);


--
-- Name: project_tag; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_tag (
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    sort integer,
    text character varying(255) DEFAULT NULL::character varying,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: project_webhook; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_webhook (
    date_created timestamp with time zone,
    date_updated timestamp with time zone,
    deleted_at timestamp with time zone,
    events text,
    id uuid NOT NULL,
    name text,
    project_id uuid,
    secret character varying(255) DEFAULT NULL::character varying,
    status character varying(255) DEFAULT 'published'::character varying NOT NULL,
    url text,
    user_created uuid,
    user_updated uuid
);


--
-- Name: prompt_template; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prompt_template (
    content text,
    date_created timestamp with time zone,
    date_updated timestamp with time zone,
    description text,
    icon character varying(50) DEFAULT NULL::character varying,
    id uuid NOT NULL,
    is_anonymous boolean,
    is_public boolean DEFAULT false,
    language character varying(255) DEFAULT NULL::character varying,
    scope character varying(255) DEFAULT 'user'::character varying NOT NULL,
    sort integer,
    tags text,
    title character varying(200) DEFAULT NULL::character varying NOT NULL,
    user_created uuid,
    workspace_id uuid
);


--
-- Name: recording_overage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recording_overage (
    billing_account_id uuid,
    cap integer,
    closed_notified_at timestamp with time zone,
    ended_at timestamp with time zone,
    excess integer,
    id uuid NOT NULL,
    opened_by_project_id uuid,
    opened_notified_at timestamp with time zone,
    peak integer,
    started_at timestamp with time zone NOT NULL
);


--
-- Name: referral_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.referral_ledger (
    created_by_staff_id uuid,
    deleted_at timestamp with time zone,
    expires_at timestamp with time zone,
    id integer NOT NULL,
    notes text,
    partner_kickback_percent integer DEFAULT 20 NOT NULL,
    partner_team_id uuid NOT NULL,
    starts_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    workspace_id uuid NOT NULL
);


--
-- Name: referral_ledger_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.referral_ledger_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: referral_ledger_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.referral_ledger_id_seq OWNED BY public.referral_ledger.id;


--
-- Name: scheduled_task; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scheduled_task (
    attempts integer DEFAULT 0,
    claimed_at timestamp with time zone,
    created_at timestamp with time zone,
    error text,
    id uuid NOT NULL,
    payload json,
    scheduled_at timestamp with time zone NOT NULL,
    status character varying(255) DEFAULT 'scheduled'::character varying NOT NULL,
    task_type character varying(255) DEFAULT 'revoke_staff_support'::character varying NOT NULL,
    updated_at timestamp with time zone
);


--
-- Name: support_access_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_access_event (
    actor_user_id uuid,
    created_at timestamp with time zone NOT NULL,
    event_code character varying(255) DEFAULT NULL::character varying NOT NULL,
    id uuid NOT NULL,
    params json,
    staff_user_id uuid,
    workspace_id uuid NOT NULL
);


--
-- Name: support_access_request; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_access_request (
    created_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone,
    id uuid NOT NULL,
    membership_id uuid,
    message text,
    requested_by uuid NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by uuid,
    status character varying(255) DEFAULT 'pending'::character varying NOT NULL,
    workspace_id uuid NOT NULL
);


--
-- Name: support_request; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_request (
    app_user_id character varying(255) DEFAULT NULL::character varying,
    chat_id character varying(255) DEFAULT NULL::character varying,
    created_at timestamp with time zone,
    directus_user_id character varying(255) DEFAULT NULL::character varying,
    forwarded_at timestamp with time zone,
    id uuid NOT NULL,
    message text,
    message_id character varying(255) DEFAULT NULL::character varying,
    page_context text,
    project_chat_id character varying(255) DEFAULT NULL::character varying,
    project_id character varying(255) DEFAULT NULL::character varying,
    source character varying(255) DEFAULT NULL::character varying,
    status character varying(255) DEFAULT 'new'::character varying,
    workspace_id character varying(255) DEFAULT NULL::character varying
);


--
-- Name: training; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.training (
    base_price_eur real,
    created_at timestamp with time zone,
    extra_participants integer DEFAULT 0,
    extra_price_eur real,
    grants_license boolean DEFAULT true NOT NULL,
    id uuid NOT NULL,
    included_participants integer DEFAULT 0,
    notes text,
    org_id uuid,
    requested_by uuid,
    scheduled_at timestamp with time zone,
    status character varying(255) DEFAULT 'requested'::character varying,
    type character varying(255) DEFAULT 'online'::character varying,
    updated_at timestamp with time zone
);


--
-- Name: training_license; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.training_license (
    app_user_id uuid,
    completed_at timestamp with time zone,
    created_at timestamp with time zone,
    expires_at timestamp with time zone,
    granted_by uuid,
    id uuid NOT NULL,
    org_id uuid,
    status character varying(255) DEFAULT 'active'::character varying,
    training_id uuid
);


--
-- Name: usage_insight; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usage_insight (
    app_user_id character varying(255) DEFAULT NULL::character varying,
    chat_id character varying(255) DEFAULT NULL::character varying,
    created_at timestamp with time zone,
    directus_user_id character varying(255) DEFAULT NULL::character varying,
    id uuid NOT NULL,
    insight_type character varying(255) DEFAULT 'intent'::character varying,
    message_id character varying(255) DEFAULT NULL::character varying,
    project_chat_id character varying(255) DEFAULT NULL::character varying,
    project_id character varying(255) DEFAULT NULL::character varying,
    status character varying(255) DEFAULT 'new'::character varying,
    summary text,
    workspace_id character varying(255) DEFAULT NULL::character varying
);


--
-- Name: verification_topic; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.verification_topic (
    date_created timestamp with time zone,
    date_updated timestamp with time zone,
    icon character varying(255) DEFAULT NULL::character varying,
    key character varying(255) DEFAULT NULL::character varying NOT NULL,
    project_id uuid,
    prompt text,
    sort integer,
    user_created uuid,
    user_updated uuid
);


--
-- Name: verification_topic_translations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.verification_topic_translations (
    id integer NOT NULL,
    label character varying(255) DEFAULT NULL::character varying,
    languages_code character varying(255) DEFAULT NULL::character varying,
    verification_topic_key character varying(255) DEFAULT NULL::character varying
);


--
-- Name: verification_topic_translations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.verification_topic_translations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: verification_topic_translations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.verification_topic_translations_id_seq OWNED BY public.verification_topic_translations.id;


--
-- Name: view; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.view (
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    description text,
    id uuid NOT NULL,
    language character varying(255) DEFAULT NULL::character varying,
    name character varying(255) DEFAULT NULL::character varying,
    project_analysis_run_id uuid,
    summary text,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    user_input text,
    user_input_description text
);


--
-- Name: workspace; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace (
    allow_support_access boolean DEFAULT false NOT NULL,
    billed_to_team_id uuid,
    billed_to_workspace_id uuid,
    billing_account_id uuid NOT NULL,
    context text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    created_by uuid,
    data_owner_email character varying(255) DEFAULT NULL::character varying,
    data_owner_org_name character varying(255) DEFAULT NULL::character varying,
    deleted_at timestamp with time zone,
    description text,
    effective_client_team_id uuid,
    handoff_status character varying(255) DEFAULT NULL::character varying,
    handoff_target_team_id uuid,
    id uuid NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    legal_basis character varying(255) DEFAULT NULL::character varying,
    logo_url character varying(255) DEFAULT NULL::character varying,
    name character varying(255) DEFAULT NULL::character varying NOT NULL,
    org_id uuid NOT NULL,
    partner_agreement_accepted_at timestamp with time zone,
    privacy_policy_url character varying(255) DEFAULT NULL::character varying,
    settings json DEFAULT '{}'::json,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    usage_context character varying(255) DEFAULT NULL::character varying,
    visibility character varying(255) DEFAULT 'open_to_organisation'::character varying
);


--
-- Name: workspace_invite; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_invite (
    accepted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamp with time zone,
    email character varying(255) DEFAULT NULL::character varying NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    id uuid NOT NULL,
    invited_by uuid,
    project_id uuid,
    role character varying(255) DEFAULT NULL::character varying NOT NULL,
    workspace_id uuid NOT NULL
);


--
-- Name: workspace_membership; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_membership (
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    custom_policies json DEFAULT '[]'::json,
    deleted_at timestamp with time zone,
    expires_at timestamp with time zone,
    id uuid NOT NULL,
    role character varying(255) DEFAULT NULL::character varying NOT NULL,
    source character varying(255) DEFAULT 'direct'::character varying NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL
);


--
-- Name: workspace_request; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_request (
    approved_billing_period character varying(255) DEFAULT NULL::character varying,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    decided_at timestamp with time zone,
    decided_by uuid,
    denial_reason text,
    granted_percent_discount integer,
    granted_tier character varying(255) DEFAULT NULL::character varying,
    granted_tier_expires_at timestamp with time zone,
    granted_type_discount character varying(255) DEFAULT NULL::character varying,
    id uuid NOT NULL,
    kind character varying(255) DEFAULT NULL::character varying NOT NULL,
    org_id uuid NOT NULL,
    proposed_billing_period character varying(255) DEFAULT NULL::character varying,
    proposed_name character varying(100) DEFAULT NULL::character varying,
    proposed_tier character varying(255) DEFAULT 'innovator'::character varying NOT NULL,
    proposed_visibility character varying(255) DEFAULT 'open_to_organisation'::character varying NOT NULL,
    requested_by uuid NOT NULL,
    requester_message text,
    resulting_workspace_id uuid,
    staff_notes text,
    status character varying(255) DEFAULT 'pending'::character varying NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    workspace_id uuid
);


--
-- Name: announcement_translations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcement_translations ALTER COLUMN id SET DEFAULT nextval('public.announcement_translations_id_seq'::regclass);


--
-- Name: conversation_link id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_link ALTER COLUMN id SET DEFAULT nextval('public.conversation_link_id_seq'::regclass);


--
-- Name: conversation_project_tag id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_project_tag ALTER COLUMN id SET DEFAULT nextval('public.conversation_project_tag_id_seq'::regclass);


--
-- Name: conversation_segment id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_segment ALTER COLUMN id SET DEFAULT nextval('public.conversation_segment_id_seq'::regclass);


--
-- Name: conversation_segment_conversation_chunk id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_segment_conversation_chunk ALTER COLUMN id SET DEFAULT nextval('public.conversation_segment_conversation_chunk_id_seq'::regclass);


--
-- Name: directus_activity id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_activity ALTER COLUMN id SET DEFAULT nextval('public.directus_activity_id_seq'::regclass);


--
-- Name: directus_fields id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_fields ALTER COLUMN id SET DEFAULT nextval('public.directus_fields_id_seq'::regclass);


--
-- Name: directus_notifications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_notifications ALTER COLUMN id SET DEFAULT nextval('public.directus_notifications_id_seq'::regclass);


--
-- Name: directus_permissions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_permissions ALTER COLUMN id SET DEFAULT nextval('public.directus_permissions_id_seq'::regclass);


--
-- Name: directus_presets id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_presets ALTER COLUMN id SET DEFAULT nextval('public.directus_presets_id_seq'::regclass);


--
-- Name: directus_relations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_relations ALTER COLUMN id SET DEFAULT nextval('public.directus_relations_id_seq'::regclass);


--
-- Name: directus_revisions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_revisions ALTER COLUMN id SET DEFAULT nextval('public.directus_revisions_id_seq'::regclass);


--
-- Name: directus_settings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_settings ALTER COLUMN id SET DEFAULT nextval('public.directus_settings_id_seq'::regclass);


--
-- Name: directus_sync_id_map id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_sync_id_map ALTER COLUMN id SET DEFAULT nextval('public.directus_sync_id_map_id_seq'::regclass);


--
-- Name: directus_webhooks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_webhooks ALTER COLUMN id SET DEFAULT nextval('public.directus_webhooks_id_seq'::regclass);


--
-- Name: processing_status id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.processing_status ALTER COLUMN id SET DEFAULT nextval('public.processing_status_id_seq'::regclass);


--
-- Name: project_agentic_run_event id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_agentic_run_event ALTER COLUMN id SET DEFAULT nextval('public.project_agentic_run_event_id_seq'::regclass);


--
-- Name: project_chat_conversation id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_chat_conversation ALTER COLUMN id SET DEFAULT nextval('public.project_chat_conversation_id_seq'::regclass);


--
-- Name: project_chat_message_conversation id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_chat_message_conversation ALTER COLUMN id SET DEFAULT nextval('public.project_chat_message_conversation_id_seq'::regclass);


--
-- Name: project_chat_message_conversation_1 id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_chat_message_conversation_1 ALTER COLUMN id SET DEFAULT nextval('public.project_chat_message_conversation_1_id_seq'::regclass);


--
-- Name: project_report id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_report ALTER COLUMN id SET DEFAULT nextval('public.project_report_id_seq'::regclass);


--
-- Name: project_report_metric id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_report_metric ALTER COLUMN id SET DEFAULT nextval('public.project_report_metric_id_seq'::regclass);


--
-- Name: referral_ledger id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_ledger ALTER COLUMN id SET DEFAULT nextval('public.referral_ledger_id_seq'::regclass);


--
-- Name: verification_topic_translations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verification_topic_translations ALTER COLUMN id SET DEFAULT nextval('public.verification_topic_translations_id_seq'::regclass);


--
-- Data for Name: access_request; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.access_request (actioned_at, actioned_by, deleted_at, id, requested_at, status, user_id, workspace_id) FROM stdin;
\.


--
-- Data for Name: agent_audit_event; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.agent_audit_event (app_user_id, client_id, created_at, duration_ms, grant_id, id, org_id, params, status, tool) FROM stdin;
\.


--
-- Data for Name: agent_client; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.agent_client (client_name, client_secret_encrypted, created_at, id, last_seen_at, metadata, redirect_uris, token_endpoint_auth_method) FROM stdin;
Parity agent	\N	2026-09-01 09:00:00+00	ac000000-0000-4000-8000-000000000001	\N	{}	["http://127.0.0.1:9/callback"]	none
\.


--
-- Data for Name: agent_grant; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.agent_grant (app_user_id, client_id, client_name, consent_accepted_at, consent_version, created_at, directus_user_id, expires_at, id, last_used_at, org_ids, revoked_at, scopes) FROM stdin;
a0000000-0000-4000-8000-000000000002	ac000000-0000-4000-8000-000000000001	Parity agent	2026-09-01 09:00:00+00	2026-09-06	2026-09-01 09:00:00+00	d0000000-0000-4000-8000-000000000002	2099-01-01 00:00:00+00	ad000000-0000-4000-8000-000000000001	\N	["b0000000-0000-4000-8000-000000000001"]	\N	["read","write"]
\.


--
-- Data for Name: agent_insight; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.agent_insight (chat_id, content, created_at, id, kind, message_id, project_id, source, status, suggested_capability, workspace_id) FROM stdin;
\.


--
-- Data for Name: agent_loop; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.agent_loop (acting_directus_user_id, cadence_minutes, caps, chat_id, created_at, created_from_chat_id, expires_at, failure_count, id, name, popcorn_state, project_id, report_id, status, updated_at) FROM stdin;
\.


--
-- Data for Name: agent_loop_run; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.agent_loop_run (detail, finished_at, generation_id, id, loop_id, started_at, status) FROM stdin;
\.


--
-- Data for Name: agent_memory; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.agent_memory (content, created_at, directus_user_id, id, memory_key, project_id, scope, source, updated_at, workspace_id) FROM stdin;
\.


--
-- Data for Name: agent_token; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.agent_token (created_at, expires_at, grant_id, id, kind, pair_id, revoked_at, token_hash) FROM stdin;
2026-09-01 09:00:00+00	2099-01-01 00:00:00+00	ad000000-0000-4000-8000-000000000001	ae000000-0000-4000-8000-000000000001	access	af000000-0000-4000-8000-000000000001	\N	6bd4cf3328c544159ea42e194c7ee29a130758e095f469bc2528830ae47bac73
2026-09-01 09:00:00+00	2099-01-01 00:00:00+00	ad000000-0000-4000-8000-000000000001	ae000000-0000-4000-8000-000000000002	refresh	af000000-0000-4000-8000-000000000001	\N	5c2b4c0824898ba1900189a712b1ccd03eb93468fd84303e135eab99bdcfe8a1
\.


--
-- Data for Name: analysis_feedback; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.analysis_feedback (actor_id, created_at, id, note, object_id, project_id, rating, revision_id, tags, updated_at) FROM stdin;
\.


--
-- Data for Name: analysis_last_opened; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.analysis_last_opened (id, opened_at, project_id, user_id) FROM stdin;
\.


--
-- Data for Name: analysis_object; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.analysis_object (created_at, current_revision_id, id, lineage_key, project_id, revision_count, scope_id, type, updated_at) FROM stdin;
\.


--
-- Data for Name: analysis_object_revision; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.analysis_object_revision (actor_id, attributes, change_kind, content_hash, created_at, embedding_refs, hash_version, id, object_id, origin, parent_revision_id, payload, project_id, provenance, published_at, reason, revision_number, run_id, schema_version, status, type) FROM stdin;
\.


--
-- Data for Name: analysis_outbox; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.analysis_outbox (attempts, claim, consumers, created_at, delivered_at, event_type, id, last_error, next_attempt_at, payload, project_id, run_id, scope_id, sequence, snapshot_id, status, updated_at) FROM stdin;
\.


--
-- Data for Name: analysis_relation; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.analysis_relation (attributes, basis, content_hash, created_at, from_object_id, from_revision_id, hash_version, id, project_id, provenance, published_at, run_id, status, to_object_id, to_revision_id, type) FROM stdin;
\.


--
-- Data for Name: analysis_request_key; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.analysis_request_key (created_at, id, idempotency_key, mode, project_id, run_id, scope_id) FROM stdin;
\.


--
-- Data for Name: analysis_run; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.analysis_run (attempt, checks, completed_at, context, created_at, definition, depends_on, epoch, error, execution_ref, hash_version, id, idempotency_key, input_fingerprint, input_manifest, lease, lease_expires_at, metrics, mode, output_manifest, parameters, progress, project_id, recipe_id, recipe_version, request_fingerprint, request_order, requested_by, reused_run_id, scope_id, started_at, status, updated_at, writer_fence) FROM stdin;
\.


--
-- Data for Name: analysis_scope; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.analysis_scope (created_at, current_request_order, current_run_id, current_snapshot_id, generation_epoch, id, kind, next_request_order, project_id, publication_sequence, recipe_id, scope_key, updated_at, view_id, writer, writer_fence) FROM stdin;
\.


--
-- Data for Name: analysis_snapshot; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.analysis_snapshot (content_hash, created_at, created_by, embedding_config, hash_version, id, manifest, manifest_version, parent_snapshot_id, project_id, scope_id, settings, source_event_id, versions, view_id) FROM stdin;
\.


--
-- Data for Name: analysis_step; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.analysis_step (attempt, cache_key, checkpoint, completed_at, created_at, error, hash_version, id, kind, lease, output, project_id, reused_step_id, run_id, status, step_key, step_version, updated_at, usage, validation) FROM stdin;
\.


--
-- Data for Name: announcement; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.announcement (created_at, expires_at, id, level, sort, updated_at, user_created, user_updated) FROM stdin;
\.


--
-- Data for Name: announcement_activity; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.announcement_activity (announcement_activity, created_at, id, read, sort, updated_at, user_created, user_id, user_updated) FROM stdin;
\.


--
-- Data for Name: announcement_translations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.announcement_translations (announcement_id, id, languages_code, message, title) FROM stdin;
\.


--
-- Data for Name: app_user; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.app_user (created_at, directus_user_id, display_name, email, id, onboarding_answer_json, settings, terms_accepted_at, updated_at) FROM stdin;
2026-09-27 15:41:55.033+00	d0000000-0000-4000-8000-000000000001	Parity Admin	parity-admin@example.com	a0000000-0000-4000-8000-000000000001	\N	\N	2026-09-01 09:00:00+00	2026-09-01 09:00:00+00
2026-09-27 15:41:55.036+00	d0000000-0000-4000-8000-000000000002	Alice Owner	alice.parity@example.com	a0000000-0000-4000-8000-000000000002	\N	\N	2026-09-01 09:00:00+00	2026-09-01 09:00:00+00
2026-09-27 15:41:55.038+00	d0000000-0000-4000-8000-000000000003	Bob Other	bob.parity@example.com	a0000000-0000-4000-8000-000000000003	\N	\N	2026-09-01 09:00:00+00	2026-09-01 09:00:00+00
2026-09-27 15:41:55.04+00	d0000000-0000-4000-8000-000000000004	Erin Enterprise	erin.parity@example.com	a0000000-0000-4000-8000-000000000004	\N	\N	2026-09-01 09:00:00+00	2026-09-01 09:00:00+00
2026-09-27 15:41:55.043+00	d0000000-0000-4000-8000-000000000005	Rita Readonly	rita.parity@example.com	a0000000-0000-4000-8000-000000000005	\N	\N	2026-09-01 09:00:00+00	2026-09-01 09:00:00+00
\.


--
-- Data for Name: aspect; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.aspect (created_at, description, id, image_url, long_summary, name, short_summary, updated_at, view_id) FROM stdin;
\.


--
-- Data for Name: aspect_segment; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.aspect_segment (aspect, description, id, relevant_index, segment, verbatim_transcript) FROM stdin;
\.


--
-- Data for Name: billing_account; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.billing_account (account_manager_id, billing_address_line1, billing_address_line2, billing_city, billing_country, billing_legal_name, billing_period, billing_postal_code, billing_vat_id, billing_vat_region, created_at, created_by, deleted_at, downgraded_at, downgraded_from_tier, id, label, mollie_customer_id, mollie_subscription_id, org_id, payment_failed_notified, payment_mode, percent_discount, pre_warning_sent, provisioned_seats, reconcile_failed_at, status, tier, tier_expires_at, type_discount, updated_at, workspace_id) FROM stdin;
\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	2026-09-27 15:41:55.08+00	a0000000-0000-4000-8000-000000000002	\N	\N	\N	ba000000-0000-4000-8000-000000000001	\N	\N	\N	b0000000-0000-4000-8000-000000000001	f	none	\N	f	\N	\N	none	changemaker	\N	\N	2026-09-01 09:00:00+00	\N
\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	2026-09-27 15:41:55.084+00	a0000000-0000-4000-8000-000000000003	\N	\N	\N	ba000000-0000-4000-8000-000000000002	\N	\N	\N	b0000000-0000-4000-8000-000000000002	f	none	\N	f	\N	\N	none	free	\N	\N	2026-09-01 09:00:00+00	\N
\.


--
-- Data for Name: canvas_config_revision; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.canvas_config_revision (brief, cadence_minutes, created_at, created_by, gather_spec, id, note, popcorn_settings, report_id) FROM stdin;
\.


--
-- Data for Name: canvas_generation; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.canvas_generation (config_revision_id, content_html, created_at, detail, id, report_id, status, tick_kind) FROM stdin;
\.


--
-- Data for Name: conversation; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.conversation (created_at, deleted_at, duration, id, is_all_chunks_transcribed, is_anonymized, is_audio_processing_finished, is_finished, is_over_cap, merged_audio_path, merged_transcript, move_history, participant_email, participant_name, participant_user_agent, project_id, recording_started_at, source, summary, title, token_count, updated_at) FROM stdin;
2026-09-27 15:41:55.304+00	\N	312.5	c1000000-0000-4000-8000-000000000001	t	f	t	t	f	\N	We need more charging points near the flats, the waiting list is months long. Buses stop running at eleven, so people drive even when they would rather not. Heat pumps are fine but the grid connection took our street a year.	\N	\N	Resident 1	\N	f0000000-0000-4000-8000-000000000001	2026-09-01 09:20:00+00	PORTAL_AUDIO	Charging points are scarce; late buses are missing; grid connections are slow.	Charging and buses	\N	2026-09-01 09:30:00+00
2026-09-27 15:41:55.31+00	\N	\N	c1000000-0000-4000-8000-000000000002	\N	f	f	f	f	\N	\N	\N	\N	Resident 2	\N	f0000000-0000-4000-8000-000000000001	\N	PORTAL_TEXT	\N	\N	\N	2026-09-01 09:41:00+00
2026-09-27 15:41:55.313+00	\N	60	c1000000-0000-4000-8000-000000000003	t	f	t	t	f	\N	\N	\N	\N	Kickoff	\N	f0000000-0000-4000-8000-000000000003	\N	PORTAL_AUDIO	\N	\N	\N	2026-09-01 09:55:00+00
\.


--
-- Data for Name: conversation_artifact; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.conversation_artifact (approved_at, content, conversation_id, date_created, id, key, last_updated_at, read_aloud_stream_url, topic_label, user_created, user_updated) FROM stdin;
\.


--
-- Data for Name: conversation_chunk; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.conversation_chunk (conversation_id, created_at, cross_talk_instances, desired_language, detected_language, detected_language_confidence, diarization, error, hallucination_reason, hallucination_score, id, noise_ratio, path, raw_transcript, runpod_job_status_link, runpod_request_count, silence_ratio, source, "timestamp", transcript, translation_error, updated_at) FROM stdin;
c1000000-0000-4000-8000-000000000001	2026-09-27 15:41:55.338+00	0	\N	en	\N	\N	\N	\N	\N	c2000000-0000-4000-8000-000000000001	0	\N	We need more charging points near the flats, the waiting list is months long.	\N	0	0	PORTAL_AUDIO	2026-09-01 09:20:00+00	We need more charging points near the flats, the waiting list is months long.	\N	2026-09-01 09:21:00+00
c1000000-0000-4000-8000-000000000001	2026-09-27 15:41:55.343+00	0	\N	en	\N	\N	\N	\N	\N	c2000000-0000-4000-8000-000000000002	0	\N	Buses stop running at eleven, so people drive even when they would rather not.	\N	0	0	PORTAL_AUDIO	2026-09-01 09:22:00+00	Buses stop running at eleven, so people drive even when they would rather not.	\N	2026-09-01 09:23:00+00
c1000000-0000-4000-8000-000000000001	2026-09-27 15:41:55.346+00	0	\N	en	\N	\N	\N	\N	\N	c2000000-0000-4000-8000-000000000003	0	\N	Heat pumps are fine but the grid connection took our street a year.	\N	0	0	PORTAL_AUDIO	2026-09-01 09:24:00+00	Heat pumps are fine but the grid connection took our street a year.	\N	2026-09-01 09:25:00+00
c1000000-0000-4000-8000-000000000002	2026-09-27 15:41:55.348+00	0	\N	\N	\N	\N	\N	\N	\N	c2000000-0000-4000-8000-000000000004	0	\N	\N	\N	0	0	PORTAL_TEXT	2026-09-01 09:40:00+00	Typed answer: the cycle lanes end abruptly at the ring road.	\N	2026-09-01 09:40:00+00
c1000000-0000-4000-8000-000000000003	2026-09-27 15:41:55.351+00	0	\N	en	\N	\N	\N	\N	\N	c2000000-0000-4000-8000-000000000005	0	\N	\N	\N	0	0	PORTAL_AUDIO	2026-09-01 09:50:00+00	Kickoff notes for org B.	\N	2026-09-01 09:50:00+00
\.


--
-- Data for Name: conversation_link; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.conversation_link (date_created, date_updated, id, link_type, source_conversation_id, target_conversation_id) FROM stdin;
\.


--
-- Data for Name: conversation_project_tag; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.conversation_project_tag (conversation_id, id, project_tag_id) FROM stdin;
c1000000-0000-4000-8000-000000000001	1	f2000000-0000-4000-8000-000000000001
\.


--
-- Data for Name: conversation_reply; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.conversation_reply (content_text, conversation_id, date_created, id, reply, sort, type) FROM stdin;
\.


--
-- Data for Name: conversation_segment; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.conversation_segment (config_id, contextual_transcript, conversation_id, counter, id, lightrag_flag, path, transcript) FROM stdin;
\.


--
-- Data for Name: conversation_segment_conversation_chunk; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.conversation_segment_conversation_chunk (conversation_chunk_id, conversation_segment_id, id) FROM stdin;
\.


--
-- Data for Name: directus_access; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.directus_access (id, role, "user", policy, sort) FROM stdin;
98e1e7b0-d733-4df0-82c6-2362166478c9	ba0f3a89-89cc-42ac-b7fe-4c1b454da07c	\N	a7c9e758-3808-4b40-8463-4fd7089b5c39	1
2b4ab659-59e7-4e56-ac97-00e50c8444f7	\N	\N	48f39388-5031-4e8a-9b65-6f88343447e3	1
808a827b-ff28-4878-b833-7ad4f613b4bf	4f2d48e9-5137-4f9a-9e18-9be817cb7100	\N	21d6ace3-b680-412e-86e1-e0f184049df0	1
\.


--
-- Data for Name: directus_activity; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.directus_activity (id, action, "user", "timestamp", ip, user_agent, collection, item, origin) FROM stdin;
\.


--
-- Data for Name: directus_collections; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.directus_collections (collection, icon, note, display_template, hidden, singleton, translations, archive_field, archive_app_filter, archive_value, unarchive_value, sort_field, accountability, color, item_duplication_fields, sort, "group", collapse, preview_url, versioning) FROM stdin;
\.


--
-- Data for Name: directus_comments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.directus_comments (id, collection, item, comment, date_created, date_updated, user_created, user_updated) FROM stdin;
\.


--
-- Data for Name: directus_dashboards; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.directus_dashboards (id, name, icon, note, date_created, user_created, color) FROM stdin;
\.


--
-- Data for Name: directus_extensions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.directus_extensions (enabled, id, folder, source, bundle) FROM stdin;
\.


--
-- Data for Name: directus_fields; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.directus_fields (id, collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, translations, note, conditions, required, "group", validation, validation_message, searchable) FROM stdin;
\.


--
-- Data for Name: directus_files; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.directus_files (id, storage, filename_disk, filename_download, title, type, folder, uploaded_by, created_on, modified_by, modified_on, charset, filesize, width, height, duration, embed, description, location, tags, metadata, focal_point_x, focal_point_y, tus_id, tus_data, uploaded_on) FROM stdin;
\.


--
-- Data for Name: directus_flows; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.directus_flows (id, name, icon, color, description, status, trigger, accountability, options, operation, date_created, user_created) FROM stdin;
\.


--
-- Data for Name: directus_folders; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.directus_folders (id, name, parent) FROM stdin;
416965c6-7695-4235-8322-8515c9a05820	custom_logos	\N
74232676-80e7-4f8c-8012-c0d59e6d0a24	Public	\N
da1c3f3e-4398-4dda-950e-9123c0873fbb	avatars	\N
\.


--
-- Data for Name: directus_migrations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.directus_migrations (version, name, "timestamp") FROM stdin;
\.


--
-- Data for Name: directus_notifications; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.directus_notifications (id, "timestamp", status, recipient, sender, subject, message, collection, item) FROM stdin;
\.


--
-- Data for Name: directus_operations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.directus_operations (id, name, key, type, position_x, position_y, options, resolve, reject, flow, date_created, user_created) FROM stdin;
\.


--
-- Data for Name: directus_panels; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.directus_panels (id, dashboard, name, icon, color, show_header, note, type, position_x, position_y, width, height, options, date_created, user_created) FROM stdin;
\.


--
-- Data for Name: directus_permissions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.directus_permissions (id, collection, action, permissions, validation, presets, fields, policy) FROM stdin;
\.


--
-- Data for Name: directus_policies; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.directus_policies (id, name, icon, description, ip_access, enforce_tfa, admin_access, app_access) FROM stdin;
a7c9e758-3808-4b40-8463-4fd7089b5c39	Basic User Policy	account_box	\N	\N	f	f	t
a6fd3b2e-5cec-4ee8-9e25-e490469216f0	Can read current user activity	assignment	\N	\N	f	f	f
58e26ec4-0294-4952-a655-2c4c1895988e	2FA	badge	\N	\N	t	f	f
48f39388-5031-4e8a-9b65-6f88343447e3	$t:public_label	public	$t:public_description	\N	f	f	f
21d6ace3-b680-412e-86e1-e0f184049df0	Administrator	verified	$t:admin_policy_description	\N	f	t	t
abf8a154-5b1c-4a46-ac9c-7300570f4f17	Views Pipeline Processing	badge	\N	\N	f	f	f
\.


--
-- Data for Name: directus_presets; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.directus_presets (id, bookmark, "user", role, collection, search, layout, layout_query, layout_options, refresh_interval, filter, icon, color) FROM stdin;
\.


--
-- Data for Name: directus_relations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.directus_relations (id, many_collection, many_field, one_collection, one_field, one_collection_field, one_allowed_collections, junction_field, sort_field, one_deselect_action) FROM stdin;
\.


--
-- Data for Name: directus_revisions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.directus_revisions (id, activity, collection, item, data, delta, parent, version) FROM stdin;
\.


--
-- Data for Name: directus_roles; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.directus_roles (id, name, icon, description, parent) FROM stdin;
4f2d48e9-5137-4f9a-9e18-9be817cb7100	Administrator	verified	$t:admin_description	\N
fc854a5d-246b-4ca8-9c23-891f79a99bff	Read-Only	supervised_user_circle	\N	\N
ba0f3a89-89cc-42ac-b7fe-4c1b454da07c	Basic User	supervised_user_circle	\N	\N
80fa6358-b263-4510-8d9b-be50a98a2f05	Enterprise User	supervised_user_circle	\N	ba0f3a89-89cc-42ac-b7fe-4c1b454da07c
\.


--
-- Data for Name: directus_sessions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.directus_sessions (token, "user", expires, ip, user_agent, share, origin, next_token) FROM stdin;
\.


--
-- Data for Name: directus_settings; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.directus_settings (id, project_name, project_url, project_color, project_logo, public_foreground, public_background, public_note, auth_login_attempts, auth_password_policy, storage_asset_transform, storage_asset_presets, custom_css, storage_default_folder, basemaps, mapbox_key, module_bar, project_descriptor, default_language, custom_aspect_ratios, public_favicon, default_appearance, default_theme_light, theme_light_overrides, default_theme_dark, theme_dark_overrides, report_error_url, report_bug_url, report_feature_url, public_registration, public_registration_verify_email, public_registration_role, public_registration_email_filter, visual_editor_urls, project_id, mcp_enabled, mcp_allow_deletes, mcp_prompts_collection, mcp_system_prompt_enabled, mcp_system_prompt, project_owner, project_usage, org_name, product_updates, project_status) FROM stdin;
1	parity	\N	#6644FF	\N	\N	\N	\N	25	/^.{8,}$/	all	\N	\N	\N	\N	\N	\N	\N	en-US	\N	\N	auto	\N	\N	\N	\N	\N	\N	\N	t	t	ba0f3a89-89cc-42ac-b7fe-4c1b454da07c	\N	\N	\N	t	f	\N	t	\N	\N	\N	\N	\N	\N
\.


--
-- Data for Name: directus_shares; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.directus_shares (id, name, collection, item, role, password, user_created, date_created, date_start, date_end, times_used, max_uses) FROM stdin;
\.


--
-- Data for Name: directus_sync_id_map; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.directus_sync_id_map (id, "table", sync_id, local_id, created_at) FROM stdin;
\.


--
-- Data for Name: directus_translations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.directus_translations (id, language, key, value) FROM stdin;
\.


--
-- Data for Name: directus_users; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.directus_users (id, first_name, last_name, email, password, location, title, description, tags, avatar, language, tfa_secret, status, role, token, last_access, last_page, provider, external_identifier, auth_data, email_notifications, appearance, theme_dark, theme_light, theme_light_overrides, theme_dark_overrides, text_direction, disable_create_project, hide_ai_suggestions, legal_basis, privacy_policy_url, quick_access_preferences, whitelabel_logo) FROM stdin;
d0000000-0000-4000-8000-000000000001	Parity	Admin	parity-admin@example.com	$argon2id$v=19$m=65536,t=3,p=1$3mmASmRrJhSOmvgAN3zcPd+xae0/mVYj8LdcuUwpVBg$APIMw7u9mmAED1OiiuxdyhJkkdQJpwSFINuGeyaFRz4	\N	\N	\N	\N	\N	\N	\N	active	4f2d48e9-5137-4f9a-9e18-9be817cb7100	\N	\N	\N	default	\N	\N	t	\N	\N	\N	\N	\N	auto	f	f	client-managed	\N	[]	\N
d0000000-0000-4000-8000-000000000002	Alice	Owner	alice.parity@example.com	$argon2id$v=19$m=65536,t=3,p=1$3mmASmRrJhSOmvgAN3zcPd+xae0/mVYj8LdcuUwpVBg$APIMw7u9mmAED1OiiuxdyhJkkdQJpwSFINuGeyaFRz4	\N	\N	\N	\N	\N	\N	\N	active	ba0f3a89-89cc-42ac-b7fe-4c1b454da07c	\N	\N	\N	default	\N	\N	t	\N	\N	\N	\N	\N	auto	f	f	client-managed	\N	[]	\N
d0000000-0000-4000-8000-000000000003	Bob	Other	bob.parity@example.com	$argon2id$v=19$m=65536,t=3,p=1$3mmASmRrJhSOmvgAN3zcPd+xae0/mVYj8LdcuUwpVBg$APIMw7u9mmAED1OiiuxdyhJkkdQJpwSFINuGeyaFRz4	\N	\N	\N	\N	\N	\N	\N	active	ba0f3a89-89cc-42ac-b7fe-4c1b454da07c	\N	\N	\N	default	\N	\N	t	\N	\N	\N	\N	\N	auto	f	f	client-managed	\N	[]	\N
d0000000-0000-4000-8000-000000000004	Erin	Enterprise	erin.parity@example.com	$argon2id$v=19$m=65536,t=3,p=1$3mmASmRrJhSOmvgAN3zcPd+xae0/mVYj8LdcuUwpVBg$APIMw7u9mmAED1OiiuxdyhJkkdQJpwSFINuGeyaFRz4	\N	\N	\N	\N	\N	\N	\N	active	80fa6358-b263-4510-8d9b-be50a98a2f05	\N	\N	\N	default	\N	\N	t	\N	\N	\N	\N	\N	auto	f	f	client-managed	\N	[]	\N
d0000000-0000-4000-8000-000000000005	Rita	Readonly	rita.parity@example.com	$argon2id$v=19$m=65536,t=3,p=1$3mmASmRrJhSOmvgAN3zcPd+xae0/mVYj8LdcuUwpVBg$APIMw7u9mmAED1OiiuxdyhJkkdQJpwSFINuGeyaFRz4	\N	\N	\N	\N	\N	\N	\N	active	fc854a5d-246b-4ca8-9c23-891f79a99bff	\N	\N	\N	default	\N	\N	t	\N	\N	\N	\N	\N	auto	f	f	client-managed	\N	[]	\N
d0000000-0000-4000-8000-000000000006	Dave	Legacy	dave.parity@example.com	$argon2id$v=19$m=65536,t=3,p=1$3mmASmRrJhSOmvgAN3zcPd+xae0/mVYj8LdcuUwpVBg$APIMw7u9mmAED1OiiuxdyhJkkdQJpwSFINuGeyaFRz4	\N	\N	\N	\N	\N	\N	\N	active	ba0f3a89-89cc-42ac-b7fe-4c1b454da07c	\N	\N	\N	default	\N	\N	t	\N	\N	\N	\N	\N	auto	f	f	client-managed	\N	[]	\N
e8d02fbd-86ef-4102-8419-8c88462ad4e9	Admin	User	directus-admin@example.com	$argon2id$v=19$m=65536,t=3,p=1$3mmASmRrJhSOmvgAN3zcPd+xae0/mVYj8LdcuUwpVBg$APIMw7u9mmAED1OiiuxdyhJkkdQJpwSFINuGeyaFRz4	\N	\N	\N	\N	\N	\N	\N	active	4f2d48e9-5137-4f9a-9e18-9be817cb7100	\N	\N	\N	default	\N	\N	t	\N	\N	\N	\N	\N	auto	f	f	client-managed	\N	[]	\N
\.


--
-- Data for Name: directus_versions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.directus_versions (id, key, name, collection, item, hash, date_created, date_updated, user_created, user_updated, delta) FROM stdin;
\.


--
-- Data for Name: directus_webhooks; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.directus_webhooks (id, name, method, url, status, data, actions, collections, headers, was_active_before_deprecation, migrated_flow) FROM stdin;
\.


--
-- Data for Name: insight; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.insight (created_at, id, project_analysis_run_id, summary, title, updated_at) FROM stdin;
\.


--
-- Data for Name: languages; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.languages (code, direction, name) FROM stdin;
en-US	ltr	English (United States)
nl-NL	ltr	Dutch (Netherlands)
de-DE	ltr	German (Germany)
es-ES	ltr	Spanish (Spain)
fr-FR	ltr	French (France)
it-IT	ltr	Italian (Italy)
uk-UA	ltr	Ukrainian (Ukraine)
cs-CZ	ltr	Czech (Czech Republic)
\.


--
-- Data for Name: map_embedding; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.map_embedding (config_key, created_at, dims, id, input_hash, model, project_id, embedding) FROM stdin;
\.


--
-- Data for Name: map_fact_check; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.map_fact_check (attempt, claim_key, completed_at, created_at, error, id, justification, model, project_id, prompt_version, requested_by, sources, started_at, statement, status, updated_at, verdict) FROM stdin;
\.


--
-- Data for Name: map_result; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.map_result (completed_at, created_at, embedding_config, error, execution_ref, id, manifest, manifest_version, progress, project_id, recipe_version, requested_by, snapshot_id, source_fingerprint, status, updated_at) FROM stdin;
\.


--
-- Data for Name: methodology; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.methodology (created_at, description, framing, id, is_seeded, name, owner_directus_user_id, updated_at, visibility, workspace_id) FROM stdin;
\.


--
-- Data for Name: methodology_version; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.methodology_version (content, created_at, created_by, id, methodology_id, note) FROM stdin;
\.


--
-- Data for Name: model_response_feedback; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.model_response_feedback (chat_mode, comment, context, date_created, date_updated, id, project_id, rating, reason, reasons, response_snapshot, target_id, target_type, user_id) FROM stdin;
\.


--
-- Data for Name: notification; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.notification (action, actor_user_id, audience_user_id, created_at, event_code, expires_at, id, message, params, read_at, ref_chat_id, ref_conversation_id, ref_invite_id, ref_org_id, ref_project_id, ref_report_id, ref_workspace_id, scope, severity, title, updated_at) FROM stdin;
\.


--
-- Data for Name: org; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.org (agent_access_enabled, agent_access_updated_at, agent_access_updated_by, created_at, created_by, deleted_at, description, id, is_partner, logo_url, name, updated_at) FROM stdin;
t	2026-09-01 09:00:00+00	a0000000-0000-4000-8000-000000000002	2026-09-27 15:41:55.061+00	a0000000-0000-4000-8000-000000000002	\N	\N	b0000000-0000-4000-8000-000000000001	f	\N	Parity Org A	2026-09-01 09:00:00+00
f	\N	\N	2026-09-27 15:41:55.065+00	a0000000-0000-4000-8000-000000000003	\N	\N	b0000000-0000-4000-8000-000000000002	f	\N	Parity Org B	2026-09-01 09:00:00+00
\.


--
-- Data for Name: org_invite; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.org_invite (accepted_at, created_at, deleted_at, email, expires_at, id, invited_by, org_id, role) FROM stdin;
\.


--
-- Data for Name: org_membership; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.org_membership (created_at, custom_policies, deleted_at, id, org_id, role, updated_at, user_id) FROM stdin;
2026-09-27 15:41:55.144+00	[]	\N	e0000000-0000-4000-8000-000000000001	b0000000-0000-4000-8000-000000000001	owner	2026-09-01 09:00:00+00	a0000000-0000-4000-8000-000000000002
2026-09-27 15:41:55.149+00	[]	\N	e0000000-0000-4000-8000-000000000002	b0000000-0000-4000-8000-000000000001	admin	2026-09-01 09:00:00+00	a0000000-0000-4000-8000-000000000004
2026-09-27 15:41:55.154+00	[]	\N	e0000000-0000-4000-8000-000000000003	b0000000-0000-4000-8000-000000000002	owner	2026-09-01 09:00:00+00	a0000000-0000-4000-8000-000000000003
2026-09-27 15:41:55.165+00	[]	\N	e0000000-0000-4000-8000-000000000004	b0000000-0000-4000-8000-000000000001	member	2026-09-01 09:00:00+00	a0000000-0000-4000-8000-000000000001
\.


--
-- Data for Name: pricing_configuration; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.pricing_configuration (answered_count, answers_raw, booking_notified_at, booking_status, booking_uid, concurrency_bucket, concurrency_exact, config, config_session_id, config_shape_version, created_at, email, furthest_step, id, is_internal, locale, mount, org_id, project_id, question_set_version, reference, status, updated_at, user_id, voice_audio, voice_transcript, volume_bucket, wall_key, workspace_id) FROM stdin;
\.


--
-- Data for Name: processing_status; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.processing_status (conversation_chunk_id, conversation_id, duration_ms, event, id, message, parent, project_analysis_run_id, project_id, "timestamp") FROM stdin;
\.


--
-- Data for Name: project; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.project (anonymize_transcripts, context, conversation_ask_for_participant_name_label, conversation_title_prompt, created_at, default_conversation_ask_for_participant_email, default_conversation_ask_for_participant_name, default_conversation_description, default_conversation_finish_text, default_conversation_title, default_conversation_transcript_prompt, default_conversation_tutorial_slug, deleted_at, directus_user_id, enable_ai_title_and_tags, get_reply_mode, get_reply_prompt, host_guide, id, image_generation_model, is_canvas_enabled, is_conversation_allowed, is_dembrane_event_cta_enabled, is_enhanced_audio_processing_enabled, is_get_reply_enabled, is_project_notification_subscription_allowed, is_verify_enabled, is_verify_on_finish_enabled, language, legal_basis, methodology_version_id, move_history, name, pin_order, privacy_policy_url, selected_verification_key_list, updated_at, visibility, workspace_id) FROM stdin;
f	\N	\N	\N	2026-09-27 15:41:55.251+00	f	t	\N	\N	\N	\N	none	\N	d0000000-0000-4000-8000-000000000004	f	summarize	\N	\N	f0000000-0000-4000-8000-000000000002	PLACEHOLDER	f	t	t	f	f	f	f	f	nl	\N	\N	\N	Research interviews	\N	\N	\N	2026-09-01 09:11:00+00	private	c0000000-0000-4000-8000-000000000002
f	\N	\N	\N	2026-09-27 15:41:55.254+00	f	t	\N	\N	\N	\N	none	\N	d0000000-0000-4000-8000-000000000003	f	summarize	\N	\N	f0000000-0000-4000-8000-000000000003	PLACEHOLDER	f	t	t	f	f	f	f	f	en	\N	\N	\N	Org B kickoff	\N	\N	\N	2026-09-01 09:12:00+00	workspace	c0000000-0000-4000-8000-000000000003
f	\N	\N	\N	2026-09-27 15:41:55.257+00	f	t	\N	\N	\N	\N	none	\N	d0000000-0000-4000-8000-000000000006	f	summarize	\N	\N	f0000000-0000-4000-8000-000000000004	PLACEHOLDER	f	t	t	f	f	f	f	f	en	\N	\N	\N	Legacy project	\N	\N	\N	2026-09-01 09:01:00+00	workspace	\N
f	Residents on energy and mobility.	\N	\N	2026-09-27 15:41:55.247+00	f	t	\N	\N	\N	\N	none	\N	d0000000-0000-4000-8000-000000000002	f	summarize	\N	\N	f0000000-0000-4000-8000-000000000001	PLACEHOLDER	f	t	t	f	f	f	t	f	en	\N	\N	\N	City listening 2026	\N	\N	agreements,gems,parity-local-priorities	2026-09-27 15:41:55.45+00	workspace	c0000000-0000-4000-8000-000000000001
\.


--
-- Data for Name: project_agentic_run; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.project_agentic_run (agent_thread_id, completed_at, created_at, directus_user_id, id, last_event_seq, latest_error, latest_error_code, latest_output, project_chat_id, project_id, started_at, status, updated_at) FROM stdin;
\.


--
-- Data for Name: project_agentic_run_event; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.project_agentic_run_event (event_type, id, payload, project_agentic_run_id, seq, "timestamp") FROM stdin;
\.


--
-- Data for Name: project_analysis_run; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.project_analysis_run (created_at, id, project_id, updated_at) FROM stdin;
\.


--
-- Data for Name: project_chat; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.project_chat (auto_select, chat_mode, date_created, date_updated, deleted_at, id, is_private, name, project_id, user_created, user_updated) FROM stdin;
f	deep_dive	2026-09-27 15:41:55.375+00	\N	\N	c3000000-0000-4000-8000-000000000001	f	What do residents want?	f0000000-0000-4000-8000-000000000001	e8d02fbd-86ef-4102-8419-8c88462ad4e9	\N
\.


--
-- Data for Name: project_chat_conversation; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.project_chat_conversation (conversation_id, id, project_chat_id) FROM stdin;
c1000000-0000-4000-8000-000000000001	1	c3000000-0000-4000-8000-000000000001
\.


--
-- Data for Name: project_chat_message; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.project_chat_message (date_created, date_updated, id, message_from, project_chat_id, template_key, text, tokens_count) FROM stdin;
2026-09-27 15:41:55.4+00	\N	c4000000-0000-4000-8000-000000000001	user	c3000000-0000-4000-8000-000000000001	\N	What do residents want most?	7
2026-09-27 15:41:55.402+00	\N	c4000000-0000-4000-8000-000000000002	assistant	c3000000-0000-4000-8000-000000000001	\N	More charging points and later buses.	9
\.


--
-- Data for Name: project_chat_message_conversation; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.project_chat_message_conversation (conversation_id, id, project_chat_message_id) FROM stdin;
\.


--
-- Data for Name: project_chat_message_conversation_1; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.project_chat_message_conversation_1 (conversation_id, id, project_chat_message_id) FROM stdin;
\.


--
-- Data for Name: project_goal_revision; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.project_goal_revision (chat_id, content, created_at, created_by, id, project_id, set_by) FROM stdin;
\.


--
-- Data for Name: project_membership; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.project_membership (created_at, custom_policies, granted_by, id, project_id, user_id) FROM stdin;
\.


--
-- Data for Name: project_report; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.project_report (content, date_created, date_updated, deleted_at, error_code, error_message, id, kind, language, project_id, public_token, scheduled_at, show_portal_link, status, user_created, user_instructions) FROM stdin;
# City listening\n\nResidents ask for charging points and later buses.	2026-09-27 15:41:55.414+00	\N	\N	\N	\N	1	report	en	f0000000-0000-4000-8000-000000000001	\N	\N	f	published	d0000000-0000-4000-8000-000000000002	\N
\.


--
-- Data for Name: project_report_metric; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.project_report_metric (date_created, date_updated, id, ip, project_report_id, type) FROM stdin;
\.


--
-- Data for Name: project_report_notification_participants; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.project_report_notification_participants (conversation_id, date_submitted, date_updated, email, email_opt_in, email_opt_out_token, id, project_id, sort) FROM stdin;
\.


--
-- Data for Name: project_tag; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.project_tag (created_at, id, project_id, sort, text, updated_at) FROM stdin;
2026-09-27 15:41:55.284+00	f2000000-0000-4000-8000-000000000001	f0000000-0000-4000-8000-000000000001	1	energy	2026-09-01 09:10:00+00
2026-09-27 15:41:55.286+00	f2000000-0000-4000-8000-000000000002	f0000000-0000-4000-8000-000000000001	2	mobility	2026-09-01 09:10:00+00
\.


--
-- Data for Name: project_webhook; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.project_webhook (date_created, date_updated, deleted_at, events, id, name, project_id, secret, status, url, user_created, user_updated) FROM stdin;
2026-09-27 15:41:55.48+00	\N	\N	["conversation.transcribed","report.generated"]	f1000000-0000-4000-8000-000000000001	Parity sink	f0000000-0000-4000-8000-000000000001	\N	published	http://127.0.0.1:9/webhook	e8d02fbd-86ef-4102-8419-8c88462ad4e9	\N
\.


--
-- Data for Name: prompt_template; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.prompt_template (content, date_created, date_updated, description, icon, id, is_anonymous, is_public, language, scope, sort, tags, title, user_created, workspace_id) FROM stdin;
\.


--
-- Data for Name: recording_overage; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.recording_overage (billing_account_id, cap, closed_notified_at, ended_at, excess, id, opened_by_project_id, opened_notified_at, peak, started_at) FROM stdin;
\.


--
-- Data for Name: referral_ledger; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.referral_ledger (created_by_staff_id, deleted_at, expires_at, id, notes, partner_kickback_percent, partner_team_id, starts_at, workspace_id) FROM stdin;
\.


--
-- Data for Name: scheduled_task; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.scheduled_task (attempts, claimed_at, created_at, error, id, payload, scheduled_at, status, task_type, updated_at) FROM stdin;
\.


--
-- Data for Name: support_access_event; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.support_access_event (actor_user_id, created_at, event_code, id, params, staff_user_id, workspace_id) FROM stdin;
\.


--
-- Data for Name: support_access_request; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.support_access_request (created_at, expires_at, id, membership_id, message, requested_by, resolved_at, resolved_by, status, workspace_id) FROM stdin;
\.


--
-- Data for Name: support_request; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.support_request (app_user_id, chat_id, created_at, directus_user_id, forwarded_at, id, message, message_id, page_context, project_chat_id, project_id, source, status, workspace_id) FROM stdin;
\.


--
-- Data for Name: training; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.training (base_price_eur, created_at, extra_participants, extra_price_eur, grants_license, id, included_participants, notes, org_id, requested_by, scheduled_at, status, type, updated_at) FROM stdin;
\.


--
-- Data for Name: training_license; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.training_license (app_user_id, completed_at, created_at, expires_at, granted_by, id, org_id, status, training_id) FROM stdin;
\.


--
-- Data for Name: usage_insight; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.usage_insight (app_user_id, chat_id, created_at, directus_user_id, id, insight_type, message_id, project_chat_id, project_id, status, summary, workspace_id) FROM stdin;
\.


--
-- Data for Name: verification_topic; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.verification_topic (date_created, date_updated, icon, key, project_id, prompt, sort, user_created, user_updated) FROM stdin;
2026-09-27 15:41:53.906+00	\N	:white_check_mark:	agreements	\N	Extract the concrete agreements and shared understandings from this conversation. Focus on points where multiple participants explicitly or implicitly aligned. Include both major decisions and small points of consensus. Present these as clear, unambiguous statements that all participants would recognize as accurate. Distinguish between firm agreements and tentative consensus. If participants used different words to express the same idea, synthesize into shared language. Format as a living document of mutual understanding. Output character should be diplomatic but precise, like meeting minutes with soul.	1	e8d02fbd-86ef-4102-8419-8c88462ad4e9	\N
2026-09-27 15:41:53.948+00	\N	:mag:	gems	\N	Identify the valuable insights that emerged unexpectedly or were mentioned briefly but contain significant potential. Look for: throwaway comments that solve problems, questions that reframe the entire discussion, metaphors that clarify complex ideas, connections between seemingly unrelated points, and wisdom hiding in personal anecdotes. Present these as discoveries worth preserving, explaining why each gem matters. These are the insights people might forget but shouldn't. Output character should be excited and precise.	2	e8d02fbd-86ef-4102-8419-8c88462ad4e9	\N
2026-09-27 15:41:53.985+00	\N	:eyes:	truths	\N	Surface the uncomfortable realities acknowledged in this conversation - the elephants in the room that got named, the difficult facts accepted, the challenging feedback given or received. Include systemic problems identified, personal blind spots revealed, and market realities confronted. Present these with compassion but without sugar-coating. Frame them as shared recognitions that took courage to voice. These truths are painful but necessary for genuine progress. Output character should be gentle but unflinching.	3	e8d02fbd-86ef-4102-8419-8c88462ad4e9	\N
2026-09-27 15:41:54.021+00	\N	:rocket:	moments	\N	Capture the moments when thinking shifted, new possibilities emerged, or collective understanding jumped to a new level. Identify: sudden realizations, creative solutions, perspective shifts, moments when complexity became simple, and ideas that energized the group. Show both the breakthrough itself and what made it possible. These are the moments when the conversation transcended its starting point. Output character should be energetic and forward-looking.	4	e8d02fbd-86ef-4102-8419-8c88462ad4e9	\N
2026-09-27 15:41:54.056+00	\N	:arrow_upper_right:	actions	\N	Synthesize the group's emerging sense of direction and next steps. Include: explicit recommendations made, implicit preferences expressed, priorities that emerged through discussion, and logical next actions even if not explicitly stated. Distinguish between unanimous direction and majority leanings. Present as provisional navigation rather than fixed commands. This is the group's best current thinking about the path forward. Output character should be pragmatic but inspirational.	5	e8d02fbd-86ef-4102-8419-8c88462ad4e9	\N
2026-09-27 15:41:54.095+00	\N	:warning:	disagreements	\N	Document the points of productive tension where different perspectives remained distinct but respected. Include: fundamental differences in approach, varying priorities, different risk tolerances, and contrasting interpretations of data. Frame these not as failures to agree but as valuable diversity of thought. Show how each perspective has merit. These disagreements are features, not bugs - they prevent premature convergence and keep important tensions alive. Output character should be respectful and balanced.	6	e8d02fbd-86ef-4102-8419-8c88462ad4e9	\N
2026-09-27 15:41:55.434+00	\N	\N	parity-local-priorities	f0000000-0000-4000-8000-000000000001	What are the local priorities?	\N	e8d02fbd-86ef-4102-8419-8c88462ad4e9	\N
\.


--
-- Data for Name: verification_topic_translations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.verification_topic_translations (id, label, languages_code, verification_topic_key) FROM stdin;
1	What we actually agreed on	en-US	agreements
2	Waar we het over eens werden	nl-NL	agreements
3	Worauf wir uns wirklich geeinigt haben	de-DE	agreements
4	En qué estuvimos de acuerdo	es-ES	agreements
5	Ce qu'on a décidé ensemble	fr-FR	agreements
6	Su cosa ci siamo accordati	it-IT	agreements
7	Про що ми домовились	uk-UA	agreements
8	Na čem jsme se shodli	cs-CZ	agreements
9	Hidden gems	en-US	gems
10	Verborgen parels	nl-NL	gems
11	Verborgene Schätze	de-DE	gems
12	Joyas ocultas	es-ES	gems
13	Pépites cachées	fr-FR	gems
14	Perle nascoste	it-IT	gems
15	Приховані перлини	uk-UA	gems
16	Skryté klenoty	cs-CZ	gems
17	Painful truths	en-US	truths
18	Pijnlijke waarheden	nl-NL	truths
19	Unbequeme Wahrheiten	de-DE	truths
20	Verdades incómodas	es-ES	truths
21	Vérités difficiles	fr-FR	truths
22	Verità scomode	it-IT	truths
23	Болючі істини	uk-UA	truths
24	Bolestivé pravdy	cs-CZ	truths
25	Breakthrough moments	en-US	moments
26	Doorbraken	nl-NL	moments
27	Durchbrüche	de-DE	moments
28	Momentos decisivos	es-ES	moments
29	Moments décisifs	fr-FR	moments
30	Momenti di svolta	it-IT	moments
31	Моменти прориву	uk-UA	moments
32	Průlomové okamžiky	cs-CZ	moments
33	What we think should happen	en-US	actions
34	Wat we denken dat moet gebeuren	nl-NL	actions
35	Was wir denken, das passieren sollte	de-DE	actions
36	Lo que creemos que debe pasar	es-ES	actions
37	Ce qu'on pense qu'il faut faire	fr-FR	actions
38	Cosa pensiamo debba succedere	it-IT	actions
39	Що, на нашу думку, має статися	uk-UA	actions
40	Co by se podle nás mělo stát	cs-CZ	actions
41	Moments we agreed to disagree	en-US	disagreements
42	Waar we het oneens bleven	nl-NL	disagreements
43	Worüber wir uns nicht einig wurden	de-DE	disagreements
44	Donde no coincidimos	es-ES	disagreements
45	Là où on n'était pas d'accord	fr-FR	disagreements
46	Dove non eravamo d'accordo	it-IT	disagreements
47	Де ми погодились не погоджуватись	uk-UA	disagreements
48	Kdy jsme se shodli, že se neshodneme	cs-CZ	disagreements
49	Local priorities	en-US	parity-local-priorities
\.


--
-- Data for Name: view; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.view (created_at, description, id, language, name, project_analysis_run_id, summary, updated_at, user_input, user_input_description) FROM stdin;
\.


--
-- Data for Name: workspace; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.workspace (allow_support_access, billed_to_team_id, billed_to_workspace_id, billing_account_id, context, created_at, created_by, data_owner_email, data_owner_org_name, deleted_at, description, effective_client_team_id, handoff_status, handoff_target_team_id, id, is_default, legal_basis, logo_url, name, org_id, partner_agreement_accepted_at, privacy_policy_url, settings, updated_at, usage_context, visibility) FROM stdin;
f	\N	\N	ba000000-0000-4000-8000-000000000001	\N	2026-09-27 15:41:55.103+00	a0000000-0000-4000-8000-000000000002	\N	\N	\N	\N	\N	\N	\N	c0000000-0000-4000-8000-000000000001	t	\N	\N	Default	b0000000-0000-4000-8000-000000000001	\N	\N	{}	2026-09-01 09:00:00+00	\N	open_to_organisation
f	\N	\N	ba000000-0000-4000-8000-000000000001	\N	2026-09-27 15:41:55.109+00	a0000000-0000-4000-8000-000000000004	\N	\N	\N	\N	\N	\N	\N	c0000000-0000-4000-8000-000000000002	f	\N	\N	Research	b0000000-0000-4000-8000-000000000001	\N	\N	{}	2026-09-01 09:05:00+00	\N	private
f	\N	\N	ba000000-0000-4000-8000-000000000002	\N	2026-09-27 15:41:55.115+00	a0000000-0000-4000-8000-000000000003	\N	\N	\N	\N	\N	\N	\N	c0000000-0000-4000-8000-000000000003	t	\N	\N	Default	b0000000-0000-4000-8000-000000000002	\N	\N	{}	2026-09-01 09:00:00+00	\N	open_to_organisation
\.


--
-- Data for Name: workspace_invite; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.workspace_invite (accepted_at, created_at, deleted_at, email, expires_at, id, invited_by, project_id, role, workspace_id) FROM stdin;
\.


--
-- Data for Name: workspace_membership; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.workspace_membership (created_at, custom_policies, deleted_at, expires_at, id, role, source, updated_at, user_id, workspace_id) FROM stdin;
2026-09-27 15:41:55.201+00	[]	\N	\N	e1000000-0000-4000-8000-000000000001	owner	direct	2026-09-01 09:00:00+00	a0000000-0000-4000-8000-000000000002	c0000000-0000-4000-8000-000000000001
2026-09-27 15:41:55.205+00	[]	\N	\N	e1000000-0000-4000-8000-000000000002	admin	direct	2026-09-01 09:00:00+00	a0000000-0000-4000-8000-000000000004	c0000000-0000-4000-8000-000000000001
2026-09-27 15:41:55.209+00	[]	\N	\N	e1000000-0000-4000-8000-000000000003	member	direct	2026-09-01 09:00:00+00	a0000000-0000-4000-8000-000000000001	c0000000-0000-4000-8000-000000000001
2026-09-27 15:41:55.212+00	[]	\N	\N	e1000000-0000-4000-8000-000000000004	owner	direct	2026-09-01 09:00:00+00	a0000000-0000-4000-8000-000000000004	c0000000-0000-4000-8000-000000000002
2026-09-27 15:41:55.216+00	[]	\N	\N	e1000000-0000-4000-8000-000000000005	member	direct	2026-09-01 09:00:00+00	a0000000-0000-4000-8000-000000000002	c0000000-0000-4000-8000-000000000002
2026-09-27 15:41:55.225+00	[]	\N	\N	e1000000-0000-4000-8000-000000000006	external	direct	2026-09-01 09:00:00+00	a0000000-0000-4000-8000-000000000003	c0000000-0000-4000-8000-000000000002
2026-09-27 15:41:55.228+00	[]	\N	\N	e1000000-0000-4000-8000-000000000007	observer	direct	2026-09-01 09:00:00+00	a0000000-0000-4000-8000-000000000005	c0000000-0000-4000-8000-000000000002
2026-09-27 15:41:55.231+00	[]	\N	\N	e1000000-0000-4000-8000-000000000008	owner	direct	2026-09-01 09:00:00+00	a0000000-0000-4000-8000-000000000003	c0000000-0000-4000-8000-000000000003
\.


--
-- Data for Name: workspace_request; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.workspace_request (approved_billing_period, created_at, decided_at, decided_by, denial_reason, granted_percent_discount, granted_tier, granted_tier_expires_at, granted_type_discount, id, kind, org_id, proposed_billing_period, proposed_name, proposed_tier, proposed_visibility, requested_by, requester_message, resulting_workspace_id, staff_notes, status, updated_at, workspace_id) FROM stdin;
\.


--
-- Name: announcement_translations_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.announcement_translations_id_seq', 1, false);


--
-- Name: conversation_link_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.conversation_link_id_seq', 1, false);


--
-- Name: conversation_project_tag_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.conversation_project_tag_id_seq', 1, true);


--
-- Name: conversation_segment_conversation_chunk_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.conversation_segment_conversation_chunk_id_seq', 1, false);


--
-- Name: conversation_segment_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.conversation_segment_id_seq', 1, false);


--
-- Name: directus_activity_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.directus_activity_id_seq', 1, false);


--
-- Name: directus_fields_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.directus_fields_id_seq', 1, false);


--
-- Name: directus_notifications_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.directus_notifications_id_seq', 1, false);


--
-- Name: directus_permissions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.directus_permissions_id_seq', 1, false);


--
-- Name: directus_presets_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.directus_presets_id_seq', 1, false);


--
-- Name: directus_relations_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.directus_relations_id_seq', 1, false);


--
-- Name: directus_revisions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.directus_revisions_id_seq', 1, false);


--
-- Name: directus_settings_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.directus_settings_id_seq', 1, true);


--
-- Name: directus_sync_id_map_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.directus_sync_id_map_id_seq', 1, false);


--
-- Name: directus_webhooks_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.directus_webhooks_id_seq', 1, false);


--
-- Name: processing_status_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.processing_status_id_seq', 1, false);


--
-- Name: project_agentic_run_event_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.project_agentic_run_event_id_seq', 1, false);


--
-- Name: project_chat_conversation_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.project_chat_conversation_id_seq', 1, true);


--
-- Name: project_chat_message_conversation_1_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.project_chat_message_conversation_1_id_seq', 1, false);


--
-- Name: project_chat_message_conversation_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.project_chat_message_conversation_id_seq', 1, false);


--
-- Name: project_report_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.project_report_id_seq', 1, true);


--
-- Name: project_report_metric_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.project_report_metric_id_seq', 1, false);


--
-- Name: referral_ledger_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.referral_ledger_id_seq', 1, false);


--
-- Name: verification_topic_translations_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.verification_topic_translations_id_seq', 49, true);


--
-- Name: access_request access_request_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_request
    ADD CONSTRAINT access_request_pkey PRIMARY KEY (id);


--
-- Name: agent_audit_event agent_audit_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_audit_event
    ADD CONSTRAINT agent_audit_event_pkey PRIMARY KEY (id);


--
-- Name: agent_client agent_client_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_client
    ADD CONSTRAINT agent_client_pkey PRIMARY KEY (id);


--
-- Name: agent_grant agent_grant_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_grant
    ADD CONSTRAINT agent_grant_pkey PRIMARY KEY (id);


--
-- Name: agent_insight agent_insight_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_insight
    ADD CONSTRAINT agent_insight_pkey PRIMARY KEY (id);


--
-- Name: agent_loop agent_loop_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_loop
    ADD CONSTRAINT agent_loop_pkey PRIMARY KEY (id);


--
-- Name: agent_loop_run agent_loop_run_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_loop_run
    ADD CONSTRAINT agent_loop_run_pkey PRIMARY KEY (id);


--
-- Name: agent_memory agent_memory_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_memory
    ADD CONSTRAINT agent_memory_pkey PRIMARY KEY (id);


--
-- Name: agent_token agent_token_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_token
    ADD CONSTRAINT agent_token_pkey PRIMARY KEY (id);


--
-- Name: agent_token agent_token_token_hash_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_token
    ADD CONSTRAINT agent_token_token_hash_unique UNIQUE (token_hash);


--
-- Name: analysis_feedback analysis_feedback_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_feedback
    ADD CONSTRAINT analysis_feedback_pkey PRIMARY KEY (id);


--
-- Name: analysis_last_opened analysis_last_opened_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_last_opened
    ADD CONSTRAINT analysis_last_opened_pkey PRIMARY KEY (id);


--
-- Name: analysis_object analysis_object_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_object
    ADD CONSTRAINT analysis_object_pkey PRIMARY KEY (id);


--
-- Name: analysis_object_revision analysis_object_revision_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_object_revision
    ADD CONSTRAINT analysis_object_revision_pkey PRIMARY KEY (id);


--
-- Name: analysis_outbox analysis_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_outbox
    ADD CONSTRAINT analysis_outbox_pkey PRIMARY KEY (id);


--
-- Name: analysis_relation analysis_relation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_relation
    ADD CONSTRAINT analysis_relation_pkey PRIMARY KEY (id);


--
-- Name: analysis_request_key analysis_request_key_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_request_key
    ADD CONSTRAINT analysis_request_key_pkey PRIMARY KEY (id);


--
-- Name: analysis_run analysis_run_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_run
    ADD CONSTRAINT analysis_run_pkey PRIMARY KEY (id);


--
-- Name: analysis_scope analysis_scope_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_scope
    ADD CONSTRAINT analysis_scope_pkey PRIMARY KEY (id);


--
-- Name: analysis_snapshot analysis_snapshot_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_snapshot
    ADD CONSTRAINT analysis_snapshot_pkey PRIMARY KEY (id);


--
-- Name: analysis_step analysis_step_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_step
    ADD CONSTRAINT analysis_step_pkey PRIMARY KEY (id);


--
-- Name: announcement_activity announcement_activity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcement_activity
    ADD CONSTRAINT announcement_activity_pkey PRIMARY KEY (id);


--
-- Name: announcement announcement_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcement
    ADD CONSTRAINT announcement_pkey PRIMARY KEY (id);


--
-- Name: announcement_translations announcement_translations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcement_translations
    ADD CONSTRAINT announcement_translations_pkey PRIMARY KEY (id);


--
-- Name: app_user app_user_directus_user_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_user
    ADD CONSTRAINT app_user_directus_user_id_unique UNIQUE (directus_user_id);


--
-- Name: app_user app_user_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_user
    ADD CONSTRAINT app_user_pkey PRIMARY KEY (id);


--
-- Name: aspect aspect_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aspect
    ADD CONSTRAINT aspect_pkey PRIMARY KEY (id);


--
-- Name: aspect_segment aspect_segment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aspect_segment
    ADD CONSTRAINT aspect_segment_pkey PRIMARY KEY (id);


--
-- Name: billing_account billing_account_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_account
    ADD CONSTRAINT billing_account_pkey PRIMARY KEY (id);


--
-- Name: canvas_config_revision canvas_config_revision_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canvas_config_revision
    ADD CONSTRAINT canvas_config_revision_pkey PRIMARY KEY (id);


--
-- Name: canvas_generation canvas_generation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canvas_generation
    ADD CONSTRAINT canvas_generation_pkey PRIMARY KEY (id);


--
-- Name: conversation_artifact conversation_artifact_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_artifact
    ADD CONSTRAINT conversation_artifact_pkey PRIMARY KEY (id);


--
-- Name: conversation_chunk conversation_chunk_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_chunk
    ADD CONSTRAINT conversation_chunk_pkey PRIMARY KEY (id);


--
-- Name: conversation_link conversation_link_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_link
    ADD CONSTRAINT conversation_link_pkey PRIMARY KEY (id);


--
-- Name: conversation conversation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation
    ADD CONSTRAINT conversation_pkey PRIMARY KEY (id);


--
-- Name: conversation_project_tag conversation_project_tag_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_project_tag
    ADD CONSTRAINT conversation_project_tag_pkey PRIMARY KEY (id);


--
-- Name: conversation_reply conversation_reply_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_reply
    ADD CONSTRAINT conversation_reply_pkey PRIMARY KEY (id);


--
-- Name: conversation_segment_conversation_chunk conversation_segment_conversation_chunk_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_segment_conversation_chunk
    ADD CONSTRAINT conversation_segment_conversation_chunk_pkey PRIMARY KEY (id);


--
-- Name: conversation_segment conversation_segment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_segment
    ADD CONSTRAINT conversation_segment_pkey PRIMARY KEY (id);


--
-- Name: directus_access directus_access_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_access
    ADD CONSTRAINT directus_access_pkey PRIMARY KEY (id);


--
-- Name: directus_activity directus_activity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_activity
    ADD CONSTRAINT directus_activity_pkey PRIMARY KEY (id);


--
-- Name: directus_collections directus_collections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_collections
    ADD CONSTRAINT directus_collections_pkey PRIMARY KEY (collection);


--
-- Name: directus_comments directus_comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_comments
    ADD CONSTRAINT directus_comments_pkey PRIMARY KEY (id);


--
-- Name: directus_dashboards directus_dashboards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_dashboards
    ADD CONSTRAINT directus_dashboards_pkey PRIMARY KEY (id);


--
-- Name: directus_extensions directus_extensions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_extensions
    ADD CONSTRAINT directus_extensions_pkey PRIMARY KEY (id);


--
-- Name: directus_fields directus_fields_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_fields
    ADD CONSTRAINT directus_fields_pkey PRIMARY KEY (id);


--
-- Name: directus_files directus_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_files
    ADD CONSTRAINT directus_files_pkey PRIMARY KEY (id);


--
-- Name: directus_flows directus_flows_operation_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_flows
    ADD CONSTRAINT directus_flows_operation_unique UNIQUE (operation);


--
-- Name: directus_flows directus_flows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_flows
    ADD CONSTRAINT directus_flows_pkey PRIMARY KEY (id);


--
-- Name: directus_folders directus_folders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_folders
    ADD CONSTRAINT directus_folders_pkey PRIMARY KEY (id);


--
-- Name: directus_migrations directus_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_migrations
    ADD CONSTRAINT directus_migrations_pkey PRIMARY KEY (version);


--
-- Name: directus_notifications directus_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_notifications
    ADD CONSTRAINT directus_notifications_pkey PRIMARY KEY (id);


--
-- Name: directus_operations directus_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_operations
    ADD CONSTRAINT directus_operations_pkey PRIMARY KEY (id);


--
-- Name: directus_operations directus_operations_reject_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_operations
    ADD CONSTRAINT directus_operations_reject_unique UNIQUE (reject);


--
-- Name: directus_operations directus_operations_resolve_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_operations
    ADD CONSTRAINT directus_operations_resolve_unique UNIQUE (resolve);


--
-- Name: directus_panels directus_panels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_panels
    ADD CONSTRAINT directus_panels_pkey PRIMARY KEY (id);


--
-- Name: directus_permissions directus_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_permissions
    ADD CONSTRAINT directus_permissions_pkey PRIMARY KEY (id);


--
-- Name: directus_policies directus_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_policies
    ADD CONSTRAINT directus_policies_pkey PRIMARY KEY (id);


--
-- Name: directus_presets directus_presets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_presets
    ADD CONSTRAINT directus_presets_pkey PRIMARY KEY (id);


--
-- Name: directus_relations directus_relations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_relations
    ADD CONSTRAINT directus_relations_pkey PRIMARY KEY (id);


--
-- Name: directus_revisions directus_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_revisions
    ADD CONSTRAINT directus_revisions_pkey PRIMARY KEY (id);


--
-- Name: directus_roles directus_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_roles
    ADD CONSTRAINT directus_roles_pkey PRIMARY KEY (id);


--
-- Name: directus_sessions directus_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_sessions
    ADD CONSTRAINT directus_sessions_pkey PRIMARY KEY (token);


--
-- Name: directus_settings directus_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_settings
    ADD CONSTRAINT directus_settings_pkey PRIMARY KEY (id);


--
-- Name: directus_shares directus_shares_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_shares
    ADD CONSTRAINT directus_shares_pkey PRIMARY KEY (id);


--
-- Name: directus_sync_id_map directus_sync_id_map_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_sync_id_map
    ADD CONSTRAINT directus_sync_id_map_pkey PRIMARY KEY (id);


--
-- Name: directus_sync_id_map directus_sync_id_map_table_local_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_sync_id_map
    ADD CONSTRAINT directus_sync_id_map_table_local_id_unique UNIQUE ("table", local_id);


--
-- Name: directus_sync_id_map directus_sync_id_map_table_sync_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_sync_id_map
    ADD CONSTRAINT directus_sync_id_map_table_sync_id_unique UNIQUE ("table", sync_id);


--
-- Name: directus_translations directus_translations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_translations
    ADD CONSTRAINT directus_translations_pkey PRIMARY KEY (id);


--
-- Name: directus_users directus_users_email_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_users
    ADD CONSTRAINT directus_users_email_unique UNIQUE (email);


--
-- Name: directus_users directus_users_external_identifier_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_users
    ADD CONSTRAINT directus_users_external_identifier_unique UNIQUE (external_identifier);


--
-- Name: directus_users directus_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_users
    ADD CONSTRAINT directus_users_pkey PRIMARY KEY (id);


--
-- Name: directus_users directus_users_token_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_users
    ADD CONSTRAINT directus_users_token_unique UNIQUE (token);


--
-- Name: directus_versions directus_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_versions
    ADD CONSTRAINT directus_versions_pkey PRIMARY KEY (id);


--
-- Name: directus_webhooks directus_webhooks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_webhooks
    ADD CONSTRAINT directus_webhooks_pkey PRIMARY KEY (id);


--
-- Name: insight insight_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insight
    ADD CONSTRAINT insight_pkey PRIMARY KEY (id);


--
-- Name: languages languages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.languages
    ADD CONSTRAINT languages_pkey PRIMARY KEY (code);


--
-- Name: map_embedding map_embedding_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.map_embedding
    ADD CONSTRAINT map_embedding_pkey PRIMARY KEY (id);


--
-- Name: map_fact_check map_fact_check_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.map_fact_check
    ADD CONSTRAINT map_fact_check_pkey PRIMARY KEY (id);


--
-- Name: map_result map_result_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.map_result
    ADD CONSTRAINT map_result_pkey PRIMARY KEY (id);


--
-- Name: methodology methodology_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.methodology
    ADD CONSTRAINT methodology_pkey PRIMARY KEY (id);


--
-- Name: methodology_version methodology_version_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.methodology_version
    ADD CONSTRAINT methodology_version_pkey PRIMARY KEY (id);


--
-- Name: model_response_feedback model_response_feedback_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_response_feedback
    ADD CONSTRAINT model_response_feedback_pkey PRIMARY KEY (id);


--
-- Name: notification notification_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification
    ADD CONSTRAINT notification_pkey PRIMARY KEY (id);


--
-- Name: org_invite org_invite_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_invite
    ADD CONSTRAINT org_invite_pkey PRIMARY KEY (id);


--
-- Name: org_membership org_membership_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_membership
    ADD CONSTRAINT org_membership_pkey PRIMARY KEY (id);


--
-- Name: org org_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org
    ADD CONSTRAINT org_pkey PRIMARY KEY (id);


--
-- Name: pricing_configuration pricing_configuration_config_session_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_configuration
    ADD CONSTRAINT pricing_configuration_config_session_id_unique UNIQUE (config_session_id);


--
-- Name: pricing_configuration pricing_configuration_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_configuration
    ADD CONSTRAINT pricing_configuration_pkey PRIMARY KEY (id);


--
-- Name: pricing_configuration pricing_configuration_reference_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_configuration
    ADD CONSTRAINT pricing_configuration_reference_unique UNIQUE (reference);


--
-- Name: processing_status processing_status_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.processing_status
    ADD CONSTRAINT processing_status_pkey PRIMARY KEY (id);


--
-- Name: project_agentic_run_event project_agentic_run_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_agentic_run_event
    ADD CONSTRAINT project_agentic_run_event_pkey PRIMARY KEY (id);


--
-- Name: project_agentic_run project_agentic_run_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_agentic_run
    ADD CONSTRAINT project_agentic_run_pkey PRIMARY KEY (id);


--
-- Name: project_analysis_run project_analysis_run_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_analysis_run
    ADD CONSTRAINT project_analysis_run_pkey PRIMARY KEY (id);


--
-- Name: project_chat_conversation project_chat_conversation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_chat_conversation
    ADD CONSTRAINT project_chat_conversation_pkey PRIMARY KEY (id);


--
-- Name: project_chat_message_conversation_1 project_chat_message_conversation_1_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_chat_message_conversation_1
    ADD CONSTRAINT project_chat_message_conversation_1_pkey PRIMARY KEY (id);


--
-- Name: project_chat_message_conversation project_chat_message_conversation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_chat_message_conversation
    ADD CONSTRAINT project_chat_message_conversation_pkey PRIMARY KEY (id);


--
-- Name: project_chat_message project_chat_message_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_chat_message
    ADD CONSTRAINT project_chat_message_pkey PRIMARY KEY (id);


--
-- Name: project_chat project_chat_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_chat
    ADD CONSTRAINT project_chat_pkey PRIMARY KEY (id);


--
-- Name: project_goal_revision project_goal_revision_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_goal_revision
    ADD CONSTRAINT project_goal_revision_pkey PRIMARY KEY (id);


--
-- Name: project_membership project_membership_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_membership
    ADD CONSTRAINT project_membership_pkey PRIMARY KEY (id);


--
-- Name: project project_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project
    ADD CONSTRAINT project_pkey PRIMARY KEY (id);


--
-- Name: project_report_metric project_report_metric_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_report_metric
    ADD CONSTRAINT project_report_metric_pkey PRIMARY KEY (id);


--
-- Name: project_report_notification_participants project_report_notification_participants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_report_notification_participants
    ADD CONSTRAINT project_report_notification_participants_pkey PRIMARY KEY (id);


--
-- Name: project_report project_report_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_report
    ADD CONSTRAINT project_report_pkey PRIMARY KEY (id);


--
-- Name: project_tag project_tag_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_tag
    ADD CONSTRAINT project_tag_pkey PRIMARY KEY (id);


--
-- Name: project_webhook project_webhook_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_webhook
    ADD CONSTRAINT project_webhook_pkey PRIMARY KEY (id);


--
-- Name: prompt_template prompt_template_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_template
    ADD CONSTRAINT prompt_template_pkey PRIMARY KEY (id);


--
-- Name: recording_overage recording_overage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recording_overage
    ADD CONSTRAINT recording_overage_pkey PRIMARY KEY (id);


--
-- Name: referral_ledger referral_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_ledger
    ADD CONSTRAINT referral_ledger_pkey PRIMARY KEY (id);


--
-- Name: scheduled_task scheduled_task_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_task
    ADD CONSTRAINT scheduled_task_pkey PRIMARY KEY (id);


--
-- Name: support_access_event support_access_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_access_event
    ADD CONSTRAINT support_access_event_pkey PRIMARY KEY (id);


--
-- Name: support_access_request support_access_request_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_access_request
    ADD CONSTRAINT support_access_request_pkey PRIMARY KEY (id);


--
-- Name: support_request support_request_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_request
    ADD CONSTRAINT support_request_pkey PRIMARY KEY (id);


--
-- Name: training_license training_license_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_license
    ADD CONSTRAINT training_license_pkey PRIMARY KEY (id);


--
-- Name: training training_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training
    ADD CONSTRAINT training_pkey PRIMARY KEY (id);


--
-- Name: usage_insight usage_insight_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_insight
    ADD CONSTRAINT usage_insight_pkey PRIMARY KEY (id);


--
-- Name: verification_topic verification_topic_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verification_topic
    ADD CONSTRAINT verification_topic_pkey PRIMARY KEY (key);


--
-- Name: verification_topic_translations verification_topic_translations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verification_topic_translations
    ADD CONSTRAINT verification_topic_translations_pkey PRIMARY KEY (id);


--
-- Name: view view_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.view
    ADD CONSTRAINT view_pkey PRIMARY KEY (id);


--
-- Name: workspace_invite workspace_invite_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invite
    ADD CONSTRAINT workspace_invite_pkey PRIMARY KEY (id);


--
-- Name: workspace_membership workspace_membership_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_membership
    ADD CONSTRAINT workspace_membership_pkey PRIMARY KEY (id);


--
-- Name: workspace workspace_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace
    ADD CONSTRAINT workspace_pkey PRIMARY KEY (id);


--
-- Name: workspace_request workspace_request_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_request
    ADD CONSTRAINT workspace_request_pkey PRIMARY KEY (id);


--
-- Name: agent_audit_event_app_user_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_audit_event_app_user_id_index ON public.agent_audit_event USING btree (app_user_id);


--
-- Name: agent_audit_event_client_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_audit_event_client_id_index ON public.agent_audit_event USING btree (client_id);


--
-- Name: agent_audit_event_created_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_audit_event_created_at_index ON public.agent_audit_event USING btree (created_at);


--
-- Name: agent_audit_event_grant_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_audit_event_grant_id_index ON public.agent_audit_event USING btree (grant_id);


--
-- Name: agent_audit_event_org_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_audit_event_org_id_index ON public.agent_audit_event USING btree (org_id);


--
-- Name: agent_audit_event_tool_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_audit_event_tool_index ON public.agent_audit_event USING btree (tool);


--
-- Name: agent_grant_app_user_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_grant_app_user_id_index ON public.agent_grant USING btree (app_user_id);


--
-- Name: agent_grant_client_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_grant_client_id_index ON public.agent_grant USING btree (client_id);


--
-- Name: agent_grant_directus_user_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_grant_directus_user_id_index ON public.agent_grant USING btree (directus_user_id);


--
-- Name: agent_grant_expires_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_grant_expires_at_index ON public.agent_grant USING btree (expires_at);


--
-- Name: agent_grant_revoked_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_grant_revoked_at_index ON public.agent_grant USING btree (revoked_at);


--
-- Name: agent_token_expires_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_token_expires_at_index ON public.agent_token USING btree (expires_at);


--
-- Name: agent_token_grant_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_token_grant_id_index ON public.agent_token USING btree (grant_id);


--
-- Name: agent_token_pair_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_token_pair_id_index ON public.agent_token USING btree (pair_id);


--
-- Name: agent_token_revoked_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_token_revoked_at_index ON public.agent_token USING btree (revoked_at);


--
-- Name: agent_token_token_hash_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_token_token_hash_index ON public.agent_token USING btree (token_hash);


--
-- Name: analysis_feedback_project_object_actor; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX analysis_feedback_project_object_actor ON public.analysis_feedback USING btree (project_id, object_id, actor_id);


--
-- Name: analysis_last_opened_project_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX analysis_last_opened_project_user ON public.analysis_last_opened USING btree (project_id, user_id);


--
-- Name: analysis_object_project_lineage; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX analysis_object_project_lineage ON public.analysis_object USING btree (project_id, type, lineage_key);


--
-- Name: analysis_object_revision_object_number; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX analysis_object_revision_object_number ON public.analysis_object_revision USING btree (object_id, revision_number);


--
-- Name: analysis_object_revision_one_staged_per_run; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX analysis_object_revision_one_staged_per_run ON public.analysis_object_revision USING btree (run_id, object_id) WHERE ((status)::text = ANY (ARRAY[('staged'::character varying)::text, ('candidate'::character varying)::text]));


--
-- Name: analysis_object_revision_run_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analysis_object_revision_run_status ON public.analysis_object_revision USING btree (run_id, status);


--
-- Name: analysis_outbox_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analysis_outbox_due ON public.analysis_outbox USING btree (next_attempt_at, created_at) WHERE ((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('dispatching'::character varying)::text]));


--
-- Name: analysis_outbox_scope_sequence; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX analysis_outbox_scope_sequence ON public.analysis_outbox USING btree (scope_id, sequence);


--
-- Name: analysis_relation_one_staged_per_run; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX analysis_relation_one_staged_per_run ON public.analysis_relation USING btree (run_id, type, from_revision_id, to_revision_id) WHERE ((status)::text = 'staged'::text);


--
-- Name: analysis_relation_published_from; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analysis_relation_published_from ON public.analysis_relation USING btree (from_revision_id, type) WHERE ((status)::text = 'published'::text);


--
-- Name: analysis_relation_published_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analysis_relation_published_to ON public.analysis_relation USING btree (to_revision_id, type) WHERE ((status)::text = 'published'::text);


--
-- Name: analysis_relation_run_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analysis_relation_run_status ON public.analysis_relation USING btree (run_id, status);


--
-- Name: analysis_request_key_project_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX analysis_request_key_project_key ON public.analysis_request_key USING btree (project_id, idempotency_key);


--
-- Name: analysis_request_key_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analysis_request_key_run ON public.analysis_request_key USING btree (run_id, created_at);


--
-- Name: analysis_run_one_active_request; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX analysis_run_one_active_request ON public.analysis_run USING btree (scope_id, request_fingerprint) WHERE ((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('waiting_for_inputs'::character varying)::text, ('running'::character varying)::text]));


--
-- Name: analysis_run_project_idempotency; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX analysis_run_project_idempotency ON public.analysis_run USING btree (project_id, idempotency_key);


--
-- Name: analysis_run_running_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analysis_run_running_expiry ON public.analysis_run USING btree (lease_expires_at, id) WHERE ((status)::text = 'running'::text);


--
-- Name: analysis_run_running_lease; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analysis_run_running_lease ON public.analysis_run USING btree (recipe_id, lease_expires_at) WHERE ((status)::text = 'running'::text);


--
-- Name: analysis_run_scope_request_order; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX analysis_run_scope_request_order ON public.analysis_run USING btree (scope_id, request_order);


--
-- Name: analysis_run_scope_status_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analysis_run_scope_status_created ON public.analysis_run USING btree (scope_id, status, created_at DESC);


--
-- Name: analysis_run_waiting_by_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analysis_run_waiting_by_project ON public.analysis_run USING btree (project_id, created_at) WHERE ((status)::text = 'waiting_for_inputs'::text);


--
-- Name: analysis_scope_producer_identity; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX analysis_scope_producer_identity ON public.analysis_scope USING btree (project_id, recipe_id, scope_key) WHERE ((kind)::text = 'producer'::text);


--
-- Name: analysis_scope_view_identity; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX analysis_scope_view_identity ON public.analysis_scope USING btree (project_id, view_id, scope_key) WHERE ((kind)::text = 'view'::text);


--
-- Name: analysis_snapshot_scope_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analysis_snapshot_scope_created ON public.analysis_snapshot USING btree (scope_id, created_at DESC);


--
-- Name: analysis_snapshot_scope_source_event; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX analysis_snapshot_scope_source_event ON public.analysis_snapshot USING btree (scope_id, source_event_id) WHERE (source_event_id IS NOT NULL);


--
-- Name: analysis_step_project_cache; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analysis_step_project_cache ON public.analysis_step USING btree (project_id, cache_key, completed_at DESC) WHERE (((status)::text = 'completed'::text) AND (reused_step_id IS NULL));


--
-- Name: analysis_step_run_step; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX analysis_step_run_step ON public.analysis_step USING btree (run_id, step_key);


--
-- Name: conversation_chunk_timestamp_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversation_chunk_timestamp_index ON public.conversation_chunk USING btree ("timestamp");


--
-- Name: conversation_link_source_conversation_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversation_link_source_conversation_id_index ON public.conversation_link USING btree (source_conversation_id);


--
-- Name: conversation_link_target_conversation_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversation_link_target_conversation_id_index ON public.conversation_link USING btree (target_conversation_id);


--
-- Name: directus_sync_id_map_created_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX directus_sync_id_map_created_at_index ON public.directus_sync_id_map USING btree (created_at);


--
-- Name: map_embedding_project_input_config; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX map_embedding_project_input_config ON public.map_embedding USING btree (project_id, input_hash, config_key);


--
-- Name: map_fact_check_project_claim; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX map_fact_check_project_claim ON public.map_fact_check USING btree (project_id, claim_key);


--
-- Name: map_result_one_active_attempt; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX map_result_one_active_attempt ON public.map_result USING btree (project_id) WHERE ((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('extracting'::character varying)::text, ('embedding'::character varying)::text]));


--
-- Name: map_result_project_status_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX map_result_project_status_created ON public.map_result USING btree (project_id, status, created_at DESC);


--
-- Name: org_invite_accepted_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX org_invite_accepted_at_index ON public.org_invite USING btree (accepted_at);


--
-- Name: org_invite_deleted_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX org_invite_deleted_at_index ON public.org_invite USING btree (deleted_at);


--
-- Name: org_invite_email_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX org_invite_email_index ON public.org_invite USING btree (email);


--
-- Name: processing_status_conversation_chunk_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX processing_status_conversation_chunk_id_index ON public.processing_status USING btree (conversation_chunk_id);


--
-- Name: processing_status_conversation_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX processing_status_conversation_id_index ON public.processing_status USING btree (conversation_id);


--
-- Name: processing_status_project_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX processing_status_project_id_index ON public.processing_status USING btree (project_id);


--
-- Name: scheduled_task_scheduled_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scheduled_task_scheduled_at_index ON public.scheduled_task USING btree (scheduled_at);


--
-- Name: scheduled_task_status_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scheduled_task_status_index ON public.scheduled_task USING btree (status);


--
-- Name: support_access_event_created_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX support_access_event_created_at_index ON public.support_access_event USING btree (created_at);


--
-- Name: support_access_event_event_code_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX support_access_event_event_code_index ON public.support_access_event USING btree (event_code);


--
-- Name: support_access_request_status_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX support_access_request_status_index ON public.support_access_request USING btree (status);


--
-- Name: workspace_invite_deleted_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_invite_deleted_at_index ON public.workspace_invite USING btree (deleted_at);


--
-- Name: workspace_membership_expires_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_membership_expires_at_index ON public.workspace_membership USING btree (expires_at);


--
-- Name: analysis_feedback analysis_feedback_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER analysis_feedback_guard BEFORE INSERT OR UPDATE ON public.analysis_feedback FOR EACH ROW EXECUTE FUNCTION public.analysis_feedback_guard();


--
-- Name: analysis_object analysis_object_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER analysis_object_guard BEFORE INSERT OR UPDATE ON public.analysis_object FOR EACH ROW EXECUTE FUNCTION public.analysis_object_guard();


--
-- Name: analysis_object_revision analysis_object_revision_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER analysis_object_revision_guard BEFORE INSERT OR UPDATE ON public.analysis_object_revision FOR EACH ROW EXECUTE FUNCTION public.analysis_object_revision_guard();


--
-- Name: analysis_outbox analysis_outbox_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER analysis_outbox_guard BEFORE INSERT OR UPDATE ON public.analysis_outbox FOR EACH ROW EXECUTE FUNCTION public.analysis_outbox_guard();


--
-- Name: analysis_relation analysis_relation_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER analysis_relation_guard BEFORE INSERT OR UPDATE ON public.analysis_relation FOR EACH ROW EXECUTE FUNCTION public.analysis_relation_guard();


--
-- Name: analysis_request_key analysis_request_key_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER analysis_request_key_guard BEFORE INSERT OR UPDATE ON public.analysis_request_key FOR EACH ROW EXECUTE FUNCTION public.analysis_request_key_guard();


--
-- Name: analysis_run analysis_run_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER analysis_run_guard BEFORE INSERT OR UPDATE ON public.analysis_run FOR EACH ROW EXECUTE FUNCTION public.analysis_run_guard();


--
-- Name: analysis_scope analysis_scope_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER analysis_scope_guard BEFORE INSERT OR UPDATE ON public.analysis_scope FOR EACH ROW EXECUTE FUNCTION public.analysis_scope_guard();


--
-- Name: analysis_snapshot analysis_snapshot_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER analysis_snapshot_guard BEFORE INSERT OR UPDATE ON public.analysis_snapshot FOR EACH ROW EXECUTE FUNCTION public.analysis_snapshot_guard();


--
-- Name: analysis_step analysis_step_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER analysis_step_guard BEFORE INSERT OR UPDATE ON public.analysis_step FOR EACH ROW EXECUTE FUNCTION public.analysis_step_guard();


--
-- Name: map_result map_result_snapshot_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER map_result_snapshot_guard BEFORE INSERT OR UPDATE OF snapshot_id, project_id ON public.map_result FOR EACH ROW EXECUTE FUNCTION public.map_result_snapshot_guard();


--
-- Name: access_request access_request_actioned_by_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_request
    ADD CONSTRAINT access_request_actioned_by_foreign FOREIGN KEY (actioned_by) REFERENCES public.app_user(id) ON DELETE SET NULL;


--
-- Name: access_request access_request_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_request
    ADD CONSTRAINT access_request_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.app_user(id) ON DELETE CASCADE;


--
-- Name: access_request access_request_workspace_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_request
    ADD CONSTRAINT access_request_workspace_id_foreign FOREIGN KEY (workspace_id) REFERENCES public.workspace(id) ON DELETE CASCADE;


--
-- Name: agent_loop agent_loop_project_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_loop
    ADD CONSTRAINT agent_loop_project_id_foreign FOREIGN KEY (project_id) REFERENCES public.project(id) ON DELETE SET NULL;


--
-- Name: agent_loop agent_loop_report_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_loop
    ADD CONSTRAINT agent_loop_report_id_foreign FOREIGN KEY (report_id) REFERENCES public.project_report(id) ON DELETE SET NULL;


--
-- Name: agent_loop_run agent_loop_run_generation_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_loop_run
    ADD CONSTRAINT agent_loop_run_generation_id_foreign FOREIGN KEY (generation_id) REFERENCES public.canvas_generation(id) ON DELETE SET NULL;


--
-- Name: agent_loop_run agent_loop_run_loop_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_loop_run
    ADD CONSTRAINT agent_loop_run_loop_id_foreign FOREIGN KEY (loop_id) REFERENCES public.agent_loop(id) ON DELETE SET NULL;


--
-- Name: analysis_feedback analysis_feedback_object_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_feedback
    ADD CONSTRAINT analysis_feedback_object_id_foreign FOREIGN KEY (object_id) REFERENCES public.analysis_object(id) ON DELETE CASCADE;


--
-- Name: analysis_feedback analysis_feedback_project_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_feedback
    ADD CONSTRAINT analysis_feedback_project_id_foreign FOREIGN KEY (project_id) REFERENCES public.project(id) ON DELETE CASCADE;


--
-- Name: analysis_feedback analysis_feedback_revision_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_feedback
    ADD CONSTRAINT analysis_feedback_revision_id_foreign FOREIGN KEY (revision_id) REFERENCES public.analysis_object_revision(id) ON DELETE CASCADE;


--
-- Name: analysis_last_opened analysis_last_opened_project_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_last_opened
    ADD CONSTRAINT analysis_last_opened_project_id_foreign FOREIGN KEY (project_id) REFERENCES public.project(id) ON DELETE CASCADE;


--
-- Name: analysis_object analysis_object_current_revision_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_object
    ADD CONSTRAINT analysis_object_current_revision_id_foreign FOREIGN KEY (current_revision_id) REFERENCES public.analysis_object_revision(id) ON DELETE SET NULL;


--
-- Name: analysis_object analysis_object_project_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_object
    ADD CONSTRAINT analysis_object_project_id_foreign FOREIGN KEY (project_id) REFERENCES public.project(id) ON DELETE CASCADE;


--
-- Name: analysis_object_revision analysis_object_revision_object_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_object_revision
    ADD CONSTRAINT analysis_object_revision_object_id_foreign FOREIGN KEY (object_id) REFERENCES public.analysis_object(id) ON DELETE CASCADE;


--
-- Name: analysis_object_revision analysis_object_revision_parent_revision_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_object_revision
    ADD CONSTRAINT analysis_object_revision_parent_revision_id_foreign FOREIGN KEY (parent_revision_id) REFERENCES public.analysis_object_revision(id) ON DELETE SET NULL;


--
-- Name: analysis_object_revision analysis_object_revision_project_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_object_revision
    ADD CONSTRAINT analysis_object_revision_project_id_foreign FOREIGN KEY (project_id) REFERENCES public.project(id) ON DELETE CASCADE;


--
-- Name: analysis_object_revision analysis_object_revision_run_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_object_revision
    ADD CONSTRAINT analysis_object_revision_run_id_foreign FOREIGN KEY (run_id) REFERENCES public.analysis_run(id) ON DELETE SET NULL;


--
-- Name: analysis_object analysis_object_scope_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_object
    ADD CONSTRAINT analysis_object_scope_id_foreign FOREIGN KEY (scope_id) REFERENCES public.analysis_scope(id) ON DELETE SET NULL;


--
-- Name: analysis_outbox analysis_outbox_project_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_outbox
    ADD CONSTRAINT analysis_outbox_project_id_foreign FOREIGN KEY (project_id) REFERENCES public.project(id) ON DELETE CASCADE;


--
-- Name: analysis_outbox analysis_outbox_run_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_outbox
    ADD CONSTRAINT analysis_outbox_run_id_foreign FOREIGN KEY (run_id) REFERENCES public.analysis_run(id) ON DELETE SET NULL;


--
-- Name: analysis_outbox analysis_outbox_scope_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_outbox
    ADD CONSTRAINT analysis_outbox_scope_id_foreign FOREIGN KEY (scope_id) REFERENCES public.analysis_scope(id) ON DELETE CASCADE;


--
-- Name: analysis_outbox analysis_outbox_snapshot_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_outbox
    ADD CONSTRAINT analysis_outbox_snapshot_id_foreign FOREIGN KEY (snapshot_id) REFERENCES public.analysis_snapshot(id) ON DELETE SET NULL;


--
-- Name: analysis_relation analysis_relation_from_object_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_relation
    ADD CONSTRAINT analysis_relation_from_object_id_foreign FOREIGN KEY (from_object_id) REFERENCES public.analysis_object(id) ON DELETE CASCADE;


--
-- Name: analysis_relation analysis_relation_from_revision_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_relation
    ADD CONSTRAINT analysis_relation_from_revision_id_foreign FOREIGN KEY (from_revision_id) REFERENCES public.analysis_object_revision(id) ON DELETE CASCADE;


--
-- Name: analysis_relation analysis_relation_project_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_relation
    ADD CONSTRAINT analysis_relation_project_id_foreign FOREIGN KEY (project_id) REFERENCES public.project(id) ON DELETE CASCADE;


--
-- Name: analysis_relation analysis_relation_run_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_relation
    ADD CONSTRAINT analysis_relation_run_id_foreign FOREIGN KEY (run_id) REFERENCES public.analysis_run(id) ON DELETE SET NULL;


--
-- Name: analysis_relation analysis_relation_to_object_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_relation
    ADD CONSTRAINT analysis_relation_to_object_id_foreign FOREIGN KEY (to_object_id) REFERENCES public.analysis_object(id) ON DELETE CASCADE;


--
-- Name: analysis_relation analysis_relation_to_revision_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_relation
    ADD CONSTRAINT analysis_relation_to_revision_id_foreign FOREIGN KEY (to_revision_id) REFERENCES public.analysis_object_revision(id) ON DELETE CASCADE;


--
-- Name: analysis_request_key analysis_request_key_project_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_request_key
    ADD CONSTRAINT analysis_request_key_project_id_foreign FOREIGN KEY (project_id) REFERENCES public.project(id) ON DELETE CASCADE;


--
-- Name: analysis_request_key analysis_request_key_run_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_request_key
    ADD CONSTRAINT analysis_request_key_run_id_foreign FOREIGN KEY (run_id) REFERENCES public.analysis_run(id) ON DELETE CASCADE;


--
-- Name: analysis_request_key analysis_request_key_scope_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_request_key
    ADD CONSTRAINT analysis_request_key_scope_id_foreign FOREIGN KEY (scope_id) REFERENCES public.analysis_scope(id) ON DELETE CASCADE;


--
-- Name: analysis_run analysis_run_project_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_run
    ADD CONSTRAINT analysis_run_project_id_foreign FOREIGN KEY (project_id) REFERENCES public.project(id) ON DELETE CASCADE;


--
-- Name: analysis_run analysis_run_reused_run_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_run
    ADD CONSTRAINT analysis_run_reused_run_id_foreign FOREIGN KEY (reused_run_id) REFERENCES public.analysis_run(id) ON DELETE SET NULL;


--
-- Name: analysis_run analysis_run_scope_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_run
    ADD CONSTRAINT analysis_run_scope_id_foreign FOREIGN KEY (scope_id) REFERENCES public.analysis_scope(id) ON DELETE CASCADE;


--
-- Name: analysis_scope analysis_scope_current_run_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_scope
    ADD CONSTRAINT analysis_scope_current_run_id_foreign FOREIGN KEY (current_run_id) REFERENCES public.analysis_run(id) ON DELETE SET NULL;


--
-- Name: analysis_scope analysis_scope_current_snapshot_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_scope
    ADD CONSTRAINT analysis_scope_current_snapshot_id_foreign FOREIGN KEY (current_snapshot_id) REFERENCES public.analysis_snapshot(id) ON DELETE SET NULL;


--
-- Name: analysis_scope analysis_scope_project_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_scope
    ADD CONSTRAINT analysis_scope_project_id_foreign FOREIGN KEY (project_id) REFERENCES public.project(id) ON DELETE CASCADE;


--
-- Name: analysis_snapshot analysis_snapshot_parent_snapshot_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_snapshot
    ADD CONSTRAINT analysis_snapshot_parent_snapshot_id_foreign FOREIGN KEY (parent_snapshot_id) REFERENCES public.analysis_snapshot(id) ON DELETE SET NULL;


--
-- Name: analysis_snapshot analysis_snapshot_project_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_snapshot
    ADD CONSTRAINT analysis_snapshot_project_id_foreign FOREIGN KEY (project_id) REFERENCES public.project(id) ON DELETE CASCADE;


--
-- Name: analysis_snapshot analysis_snapshot_scope_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_snapshot
    ADD CONSTRAINT analysis_snapshot_scope_id_foreign FOREIGN KEY (scope_id) REFERENCES public.analysis_scope(id) ON DELETE CASCADE;


--
-- Name: analysis_step analysis_step_project_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_step
    ADD CONSTRAINT analysis_step_project_id_foreign FOREIGN KEY (project_id) REFERENCES public.project(id) ON DELETE CASCADE;


--
-- Name: analysis_step analysis_step_reused_step_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_step
    ADD CONSTRAINT analysis_step_reused_step_id_foreign FOREIGN KEY (reused_step_id) REFERENCES public.analysis_step(id) ON DELETE SET NULL;


--
-- Name: analysis_step analysis_step_run_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_step
    ADD CONSTRAINT analysis_step_run_id_foreign FOREIGN KEY (run_id) REFERENCES public.analysis_run(id) ON DELETE CASCADE;


--
-- Name: announcement_activity announcement_activity_announcement_activity_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcement_activity
    ADD CONSTRAINT announcement_activity_announcement_activity_foreign FOREIGN KEY (announcement_activity) REFERENCES public.announcement(id) ON DELETE SET NULL;


--
-- Name: announcement_activity announcement_activity_user_created_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcement_activity
    ADD CONSTRAINT announcement_activity_user_created_foreign FOREIGN KEY (user_created) REFERENCES public.directus_users(id);


--
-- Name: announcement_activity announcement_activity_user_updated_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcement_activity
    ADD CONSTRAINT announcement_activity_user_updated_foreign FOREIGN KEY (user_updated) REFERENCES public.directus_users(id);


--
-- Name: announcement_translations announcement_translations_announcement_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcement_translations
    ADD CONSTRAINT announcement_translations_announcement_id_foreign FOREIGN KEY (announcement_id) REFERENCES public.announcement(id) ON DELETE SET NULL;


--
-- Name: announcement_translations announcement_translations_languages_code_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcement_translations
    ADD CONSTRAINT announcement_translations_languages_code_foreign FOREIGN KEY (languages_code) REFERENCES public.languages(code) ON DELETE SET NULL;


--
-- Name: announcement announcement_user_created_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcement
    ADD CONSTRAINT announcement_user_created_foreign FOREIGN KEY (user_created) REFERENCES public.directus_users(id);


--
-- Name: announcement announcement_user_updated_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcement
    ADD CONSTRAINT announcement_user_updated_foreign FOREIGN KEY (user_updated) REFERENCES public.directus_users(id);


--
-- Name: aspect_segment aspect_segment_aspect_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aspect_segment
    ADD CONSTRAINT aspect_segment_aspect_foreign FOREIGN KEY (aspect) REFERENCES public.aspect(id) ON DELETE CASCADE;


--
-- Name: aspect_segment aspect_segment_segment_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aspect_segment
    ADD CONSTRAINT aspect_segment_segment_foreign FOREIGN KEY (segment) REFERENCES public.conversation_segment(id) ON DELETE SET NULL;


--
-- Name: aspect aspect_view_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aspect
    ADD CONSTRAINT aspect_view_id_foreign FOREIGN KEY (view_id) REFERENCES public.view(id) ON DELETE SET NULL;


--
-- Name: billing_account billing_account_account_manager_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_account
    ADD CONSTRAINT billing_account_account_manager_id_foreign FOREIGN KEY (account_manager_id) REFERENCES public.app_user(id) ON DELETE SET NULL;


--
-- Name: billing_account billing_account_created_by_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_account
    ADD CONSTRAINT billing_account_created_by_foreign FOREIGN KEY (created_by) REFERENCES public.app_user(id) ON DELETE SET NULL;


--
-- Name: billing_account billing_account_org_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_account
    ADD CONSTRAINT billing_account_org_id_foreign FOREIGN KEY (org_id) REFERENCES public.org(id) ON DELETE CASCADE;


--
-- Name: billing_account billing_account_workspace_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_account
    ADD CONSTRAINT billing_account_workspace_id_foreign FOREIGN KEY (workspace_id) REFERENCES public.workspace(id) ON DELETE CASCADE;


--
-- Name: canvas_config_revision canvas_config_revision_report_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canvas_config_revision
    ADD CONSTRAINT canvas_config_revision_report_id_foreign FOREIGN KEY (report_id) REFERENCES public.project_report(id) ON DELETE SET NULL;


--
-- Name: canvas_generation canvas_generation_config_revision_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canvas_generation
    ADD CONSTRAINT canvas_generation_config_revision_id_foreign FOREIGN KEY (config_revision_id) REFERENCES public.canvas_config_revision(id) ON DELETE SET NULL;


--
-- Name: canvas_generation canvas_generation_report_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canvas_generation
    ADD CONSTRAINT canvas_generation_report_id_foreign FOREIGN KEY (report_id) REFERENCES public.project_report(id) ON DELETE SET NULL;


--
-- Name: conversation_artifact conversation_artifact_conversation_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_artifact
    ADD CONSTRAINT conversation_artifact_conversation_id_foreign FOREIGN KEY (conversation_id) REFERENCES public.conversation(id) ON DELETE CASCADE;


--
-- Name: conversation_artifact conversation_artifact_user_created_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_artifact
    ADD CONSTRAINT conversation_artifact_user_created_foreign FOREIGN KEY (user_created) REFERENCES public.directus_users(id);


--
-- Name: conversation_artifact conversation_artifact_user_updated_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_artifact
    ADD CONSTRAINT conversation_artifact_user_updated_foreign FOREIGN KEY (user_updated) REFERENCES public.directus_users(id);


--
-- Name: conversation_chunk conversation_chunk_conversation_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_chunk
    ADD CONSTRAINT conversation_chunk_conversation_id_foreign FOREIGN KEY (conversation_id) REFERENCES public.conversation(id) ON DELETE CASCADE;


--
-- Name: conversation_link conversation_link_source_conversation_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_link
    ADD CONSTRAINT conversation_link_source_conversation_id_foreign FOREIGN KEY (source_conversation_id) REFERENCES public.conversation(id) ON DELETE SET NULL;


--
-- Name: conversation_link conversation_link_target_conversation_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_link
    ADD CONSTRAINT conversation_link_target_conversation_id_foreign FOREIGN KEY (target_conversation_id) REFERENCES public.conversation(id) ON DELETE SET NULL;


--
-- Name: conversation conversation_project_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation
    ADD CONSTRAINT conversation_project_id_foreign FOREIGN KEY (project_id) REFERENCES public.project(id) ON DELETE CASCADE;


--
-- Name: conversation_project_tag conversation_project_tag_conversation_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_project_tag
    ADD CONSTRAINT conversation_project_tag_conversation_id_foreign FOREIGN KEY (conversation_id) REFERENCES public.conversation(id) ON DELETE CASCADE;


--
-- Name: conversation_project_tag conversation_project_tag_project_tag_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_project_tag
    ADD CONSTRAINT conversation_project_tag_project_tag_id_foreign FOREIGN KEY (project_tag_id) REFERENCES public.project_tag(id) ON DELETE CASCADE;


--
-- Name: conversation_reply conversation_reply_reply_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_reply
    ADD CONSTRAINT conversation_reply_reply_foreign FOREIGN KEY (reply) REFERENCES public.conversation(id) ON DELETE SET NULL;


--
-- Name: conversation_segment_conversation_chunk conversation_segment_conversation_chunk_co__1f8deab8_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_segment_conversation_chunk
    ADD CONSTRAINT conversation_segment_conversation_chunk_co__1f8deab8_foreign FOREIGN KEY (conversation_chunk_id) REFERENCES public.conversation_chunk(id) ON DELETE CASCADE;


--
-- Name: conversation_segment_conversation_chunk conversation_segment_conversation_chunk_co__4f4b4f4e_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_segment_conversation_chunk
    ADD CONSTRAINT conversation_segment_conversation_chunk_co__4f4b4f4e_foreign FOREIGN KEY (conversation_segment_id) REFERENCES public.conversation_segment(id) ON DELETE CASCADE;


--
-- Name: conversation_segment conversation_segment_conversation_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_segment
    ADD CONSTRAINT conversation_segment_conversation_id_foreign FOREIGN KEY (conversation_id) REFERENCES public.conversation(id) ON DELETE CASCADE;


--
-- Name: directus_access directus_access_policy_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_access
    ADD CONSTRAINT directus_access_policy_foreign FOREIGN KEY (policy) REFERENCES public.directus_policies(id) ON DELETE CASCADE;


--
-- Name: directus_access directus_access_role_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_access
    ADD CONSTRAINT directus_access_role_foreign FOREIGN KEY (role) REFERENCES public.directus_roles(id) ON DELETE CASCADE;


--
-- Name: directus_access directus_access_user_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_access
    ADD CONSTRAINT directus_access_user_foreign FOREIGN KEY ("user") REFERENCES public.directus_users(id) ON DELETE CASCADE;


--
-- Name: directus_collections directus_collections_group_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_collections
    ADD CONSTRAINT directus_collections_group_foreign FOREIGN KEY ("group") REFERENCES public.directus_collections(collection);


--
-- Name: directus_comments directus_comments_user_created_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_comments
    ADD CONSTRAINT directus_comments_user_created_foreign FOREIGN KEY (user_created) REFERENCES public.directus_users(id) ON DELETE SET NULL;


--
-- Name: directus_comments directus_comments_user_updated_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_comments
    ADD CONSTRAINT directus_comments_user_updated_foreign FOREIGN KEY (user_updated) REFERENCES public.directus_users(id);


--
-- Name: directus_dashboards directus_dashboards_user_created_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_dashboards
    ADD CONSTRAINT directus_dashboards_user_created_foreign FOREIGN KEY (user_created) REFERENCES public.directus_users(id) ON DELETE SET NULL;


--
-- Name: directus_files directus_files_folder_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_files
    ADD CONSTRAINT directus_files_folder_foreign FOREIGN KEY (folder) REFERENCES public.directus_folders(id) ON DELETE SET NULL;


--
-- Name: directus_files directus_files_modified_by_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_files
    ADD CONSTRAINT directus_files_modified_by_foreign FOREIGN KEY (modified_by) REFERENCES public.directus_users(id);


--
-- Name: directus_files directus_files_uploaded_by_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_files
    ADD CONSTRAINT directus_files_uploaded_by_foreign FOREIGN KEY (uploaded_by) REFERENCES public.directus_users(id);


--
-- Name: directus_flows directus_flows_user_created_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_flows
    ADD CONSTRAINT directus_flows_user_created_foreign FOREIGN KEY (user_created) REFERENCES public.directus_users(id) ON DELETE SET NULL;


--
-- Name: directus_folders directus_folders_parent_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_folders
    ADD CONSTRAINT directus_folders_parent_foreign FOREIGN KEY (parent) REFERENCES public.directus_folders(id);


--
-- Name: directus_notifications directus_notifications_recipient_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_notifications
    ADD CONSTRAINT directus_notifications_recipient_foreign FOREIGN KEY (recipient) REFERENCES public.directus_users(id) ON DELETE CASCADE;


--
-- Name: directus_notifications directus_notifications_sender_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_notifications
    ADD CONSTRAINT directus_notifications_sender_foreign FOREIGN KEY (sender) REFERENCES public.directus_users(id);


--
-- Name: directus_operations directus_operations_flow_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_operations
    ADD CONSTRAINT directus_operations_flow_foreign FOREIGN KEY (flow) REFERENCES public.directus_flows(id) ON DELETE CASCADE;


--
-- Name: directus_operations directus_operations_reject_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_operations
    ADD CONSTRAINT directus_operations_reject_foreign FOREIGN KEY (reject) REFERENCES public.directus_operations(id);


--
-- Name: directus_operations directus_operations_resolve_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_operations
    ADD CONSTRAINT directus_operations_resolve_foreign FOREIGN KEY (resolve) REFERENCES public.directus_operations(id);


--
-- Name: directus_operations directus_operations_user_created_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_operations
    ADD CONSTRAINT directus_operations_user_created_foreign FOREIGN KEY (user_created) REFERENCES public.directus_users(id) ON DELETE SET NULL;


--
-- Name: directus_panels directus_panels_dashboard_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_panels
    ADD CONSTRAINT directus_panels_dashboard_foreign FOREIGN KEY (dashboard) REFERENCES public.directus_dashboards(id) ON DELETE CASCADE;


--
-- Name: directus_panels directus_panels_user_created_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_panels
    ADD CONSTRAINT directus_panels_user_created_foreign FOREIGN KEY (user_created) REFERENCES public.directus_users(id) ON DELETE SET NULL;


--
-- Name: directus_permissions directus_permissions_policy_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_permissions
    ADD CONSTRAINT directus_permissions_policy_foreign FOREIGN KEY (policy) REFERENCES public.directus_policies(id) ON DELETE CASCADE;


--
-- Name: directus_presets directus_presets_role_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_presets
    ADD CONSTRAINT directus_presets_role_foreign FOREIGN KEY (role) REFERENCES public.directus_roles(id) ON DELETE CASCADE;


--
-- Name: directus_presets directus_presets_user_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_presets
    ADD CONSTRAINT directus_presets_user_foreign FOREIGN KEY ("user") REFERENCES public.directus_users(id) ON DELETE CASCADE;


--
-- Name: directus_revisions directus_revisions_activity_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_revisions
    ADD CONSTRAINT directus_revisions_activity_foreign FOREIGN KEY (activity) REFERENCES public.directus_activity(id) ON DELETE CASCADE;


--
-- Name: directus_revisions directus_revisions_parent_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_revisions
    ADD CONSTRAINT directus_revisions_parent_foreign FOREIGN KEY (parent) REFERENCES public.directus_revisions(id);


--
-- Name: directus_revisions directus_revisions_version_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_revisions
    ADD CONSTRAINT directus_revisions_version_foreign FOREIGN KEY (version) REFERENCES public.directus_versions(id) ON DELETE CASCADE;


--
-- Name: directus_roles directus_roles_parent_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_roles
    ADD CONSTRAINT directus_roles_parent_foreign FOREIGN KEY (parent) REFERENCES public.directus_roles(id);


--
-- Name: directus_sessions directus_sessions_share_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_sessions
    ADD CONSTRAINT directus_sessions_share_foreign FOREIGN KEY (share) REFERENCES public.directus_shares(id) ON DELETE CASCADE;


--
-- Name: directus_sessions directus_sessions_user_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_sessions
    ADD CONSTRAINT directus_sessions_user_foreign FOREIGN KEY ("user") REFERENCES public.directus_users(id) ON DELETE CASCADE;


--
-- Name: directus_settings directus_settings_project_logo_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_settings
    ADD CONSTRAINT directus_settings_project_logo_foreign FOREIGN KEY (project_logo) REFERENCES public.directus_files(id);


--
-- Name: directus_settings directus_settings_public_background_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_settings
    ADD CONSTRAINT directus_settings_public_background_foreign FOREIGN KEY (public_background) REFERENCES public.directus_files(id);


--
-- Name: directus_settings directus_settings_public_favicon_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_settings
    ADD CONSTRAINT directus_settings_public_favicon_foreign FOREIGN KEY (public_favicon) REFERENCES public.directus_files(id);


--
-- Name: directus_settings directus_settings_public_foreground_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_settings
    ADD CONSTRAINT directus_settings_public_foreground_foreign FOREIGN KEY (public_foreground) REFERENCES public.directus_files(id);


--
-- Name: directus_settings directus_settings_public_registration_role_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_settings
    ADD CONSTRAINT directus_settings_public_registration_role_foreign FOREIGN KEY (public_registration_role) REFERENCES public.directus_roles(id) ON DELETE SET NULL;


--
-- Name: directus_settings directus_settings_storage_default_folder_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_settings
    ADD CONSTRAINT directus_settings_storage_default_folder_foreign FOREIGN KEY (storage_default_folder) REFERENCES public.directus_folders(id) ON DELETE SET NULL;


--
-- Name: directus_shares directus_shares_collection_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_shares
    ADD CONSTRAINT directus_shares_collection_foreign FOREIGN KEY (collection) REFERENCES public.directus_collections(collection) ON DELETE CASCADE;


--
-- Name: directus_shares directus_shares_role_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_shares
    ADD CONSTRAINT directus_shares_role_foreign FOREIGN KEY (role) REFERENCES public.directus_roles(id) ON DELETE CASCADE;


--
-- Name: directus_shares directus_shares_user_created_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_shares
    ADD CONSTRAINT directus_shares_user_created_foreign FOREIGN KEY (user_created) REFERENCES public.directus_users(id) ON DELETE SET NULL;


--
-- Name: directus_users directus_users_role_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_users
    ADD CONSTRAINT directus_users_role_foreign FOREIGN KEY (role) REFERENCES public.directus_roles(id) ON DELETE SET NULL;


--
-- Name: directus_users directus_users_whitelabel_logo_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_users
    ADD CONSTRAINT directus_users_whitelabel_logo_foreign FOREIGN KEY (whitelabel_logo) REFERENCES public.directus_files(id) ON DELETE SET NULL;


--
-- Name: directus_versions directus_versions_collection_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_versions
    ADD CONSTRAINT directus_versions_collection_foreign FOREIGN KEY (collection) REFERENCES public.directus_collections(collection) ON DELETE CASCADE;


--
-- Name: directus_versions directus_versions_user_created_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_versions
    ADD CONSTRAINT directus_versions_user_created_foreign FOREIGN KEY (user_created) REFERENCES public.directus_users(id) ON DELETE SET NULL;


--
-- Name: directus_versions directus_versions_user_updated_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_versions
    ADD CONSTRAINT directus_versions_user_updated_foreign FOREIGN KEY (user_updated) REFERENCES public.directus_users(id);


--
-- Name: directus_webhooks directus_webhooks_migrated_flow_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_webhooks
    ADD CONSTRAINT directus_webhooks_migrated_flow_foreign FOREIGN KEY (migrated_flow) REFERENCES public.directus_flows(id) ON DELETE SET NULL;


--
-- Name: insight insight_project_analysis_run_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insight
    ADD CONSTRAINT insight_project_analysis_run_id_foreign FOREIGN KEY (project_analysis_run_id) REFERENCES public.project_analysis_run(id) ON DELETE SET NULL;


--
-- Name: map_embedding map_embedding_project_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.map_embedding
    ADD CONSTRAINT map_embedding_project_id_foreign FOREIGN KEY (project_id) REFERENCES public.project(id) ON DELETE CASCADE;


--
-- Name: map_fact_check map_fact_check_project_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.map_fact_check
    ADD CONSTRAINT map_fact_check_project_id_foreign FOREIGN KEY (project_id) REFERENCES public.project(id) ON DELETE CASCADE;


--
-- Name: map_result map_result_project_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.map_result
    ADD CONSTRAINT map_result_project_id_foreign FOREIGN KEY (project_id) REFERENCES public.project(id) ON DELETE CASCADE;


--
-- Name: map_result map_result_snapshot_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.map_result
    ADD CONSTRAINT map_result_snapshot_id_foreign FOREIGN KEY (snapshot_id) REFERENCES public.analysis_snapshot(id) ON DELETE SET NULL;


--
-- Name: methodology_version methodology_version_methodology_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.methodology_version
    ADD CONSTRAINT methodology_version_methodology_id_foreign FOREIGN KEY (methodology_id) REFERENCES public.methodology(id) ON DELETE SET NULL;


--
-- Name: methodology methodology_workspace_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.methodology
    ADD CONSTRAINT methodology_workspace_id_foreign FOREIGN KEY (workspace_id) REFERENCES public.workspace(id) ON DELETE SET NULL;


--
-- Name: model_response_feedback model_response_feedback_project_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_response_feedback
    ADD CONSTRAINT model_response_feedback_project_id_foreign FOREIGN KEY (project_id) REFERENCES public.project(id) ON DELETE SET NULL;


--
-- Name: model_response_feedback model_response_feedback_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_response_feedback
    ADD CONSTRAINT model_response_feedback_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.directus_users(id) ON DELETE SET NULL;


--
-- Name: notification notification_actor_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification
    ADD CONSTRAINT notification_actor_user_id_foreign FOREIGN KEY (actor_user_id) REFERENCES public.app_user(id) ON DELETE SET NULL;


--
-- Name: notification notification_audience_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification
    ADD CONSTRAINT notification_audience_user_id_foreign FOREIGN KEY (audience_user_id) REFERENCES public.app_user(id) ON DELETE CASCADE;


--
-- Name: notification notification_ref_chat_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification
    ADD CONSTRAINT notification_ref_chat_id_foreign FOREIGN KEY (ref_chat_id) REFERENCES public.project_chat(id) ON DELETE SET NULL;


--
-- Name: notification notification_ref_conversation_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification
    ADD CONSTRAINT notification_ref_conversation_id_foreign FOREIGN KEY (ref_conversation_id) REFERENCES public.conversation(id) ON DELETE SET NULL;


--
-- Name: notification notification_ref_invite_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification
    ADD CONSTRAINT notification_ref_invite_id_foreign FOREIGN KEY (ref_invite_id) REFERENCES public.workspace_invite(id) ON DELETE SET NULL;


--
-- Name: notification notification_ref_org_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification
    ADD CONSTRAINT notification_ref_org_id_foreign FOREIGN KEY (ref_org_id) REFERENCES public.org(id) ON DELETE SET NULL;


--
-- Name: notification notification_ref_project_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification
    ADD CONSTRAINT notification_ref_project_id_foreign FOREIGN KEY (ref_project_id) REFERENCES public.project(id) ON DELETE SET NULL;


--
-- Name: notification notification_ref_workspace_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification
    ADD CONSTRAINT notification_ref_workspace_id_foreign FOREIGN KEY (ref_workspace_id) REFERENCES public.workspace(id) ON DELETE SET NULL;


--
-- Name: org org_created_by_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org
    ADD CONSTRAINT org_created_by_foreign FOREIGN KEY (created_by) REFERENCES public.app_user(id) ON DELETE SET NULL;


--
-- Name: org_invite org_invite_invited_by_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_invite
    ADD CONSTRAINT org_invite_invited_by_foreign FOREIGN KEY (invited_by) REFERENCES public.app_user(id) ON DELETE SET NULL;


--
-- Name: org_invite org_invite_org_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_invite
    ADD CONSTRAINT org_invite_org_id_foreign FOREIGN KEY (org_id) REFERENCES public.org(id) ON DELETE CASCADE;


--
-- Name: org_membership org_membership_org_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_membership
    ADD CONSTRAINT org_membership_org_id_foreign FOREIGN KEY (org_id) REFERENCES public.org(id) ON DELETE CASCADE;


--
-- Name: org_membership org_membership_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_membership
    ADD CONSTRAINT org_membership_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.app_user(id) ON DELETE CASCADE;


--
-- Name: processing_status processing_status_conversation_chunk_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.processing_status
    ADD CONSTRAINT processing_status_conversation_chunk_id_foreign FOREIGN KEY (conversation_chunk_id) REFERENCES public.conversation_chunk(id) ON DELETE SET NULL;


--
-- Name: processing_status processing_status_conversation_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.processing_status
    ADD CONSTRAINT processing_status_conversation_id_foreign FOREIGN KEY (conversation_id) REFERENCES public.conversation(id) ON DELETE SET NULL;


--
-- Name: processing_status processing_status_parent_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.processing_status
    ADD CONSTRAINT processing_status_parent_foreign FOREIGN KEY (parent) REFERENCES public.processing_status(id);


--
-- Name: processing_status processing_status_project_analysis_run_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.processing_status
    ADD CONSTRAINT processing_status_project_analysis_run_id_foreign FOREIGN KEY (project_analysis_run_id) REFERENCES public.project_analysis_run(id) ON DELETE SET NULL;


--
-- Name: processing_status processing_status_project_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.processing_status
    ADD CONSTRAINT processing_status_project_id_foreign FOREIGN KEY (project_id) REFERENCES public.project(id) ON DELETE SET NULL;


--
-- Name: project_agentic_run_event project_agentic_run_event_project_agentic_run_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_agentic_run_event
    ADD CONSTRAINT project_agentic_run_event_project_agentic_run_id_foreign FOREIGN KEY (project_agentic_run_id) REFERENCES public.project_agentic_run(id) ON DELETE CASCADE;


--
-- Name: project_agentic_run project_agentic_run_project_chat_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_agentic_run
    ADD CONSTRAINT project_agentic_run_project_chat_id_foreign FOREIGN KEY (project_chat_id) REFERENCES public.project_chat(id) ON DELETE SET NULL;


--
-- Name: project_agentic_run project_agentic_run_project_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_agentic_run
    ADD CONSTRAINT project_agentic_run_project_id_foreign FOREIGN KEY (project_id) REFERENCES public.project(id) ON DELETE CASCADE;


--
-- Name: project_analysis_run project_analysis_run_project_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_analysis_run
    ADD CONSTRAINT project_analysis_run_project_id_foreign FOREIGN KEY (project_id) REFERENCES public.project(id) ON DELETE CASCADE;


--
-- Name: project_chat_conversation project_chat_conversation_conversation_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_chat_conversation
    ADD CONSTRAINT project_chat_conversation_conversation_id_foreign FOREIGN KEY (conversation_id) REFERENCES public.conversation(id) ON DELETE CASCADE;


--
-- Name: project_chat_conversation project_chat_conversation_project_chat_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_chat_conversation
    ADD CONSTRAINT project_chat_conversation_project_chat_id_foreign FOREIGN KEY (project_chat_id) REFERENCES public.project_chat(id) ON DELETE CASCADE;


--
-- Name: project_chat_message_conversation_1 project_chat_message_conversation_1_conversation_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_chat_message_conversation_1
    ADD CONSTRAINT project_chat_message_conversation_1_conversation_id_foreign FOREIGN KEY (conversation_id) REFERENCES public.conversation(id) ON DELETE SET NULL;


--
-- Name: project_chat_message_conversation_1 project_chat_message_conversation_1_projec__225db2e8_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_chat_message_conversation_1
    ADD CONSTRAINT project_chat_message_conversation_1_projec__225db2e8_foreign FOREIGN KEY (project_chat_message_id) REFERENCES public.project_chat_message(id) ON DELETE SET NULL;


--
-- Name: project_chat_message_conversation project_chat_message_conversation_conversation_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_chat_message_conversation
    ADD CONSTRAINT project_chat_message_conversation_conversation_id_foreign FOREIGN KEY (conversation_id) REFERENCES public.conversation(id) ON DELETE SET NULL;


--
-- Name: project_chat_message_conversation project_chat_message_conversation_project___3af13f9a_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_chat_message_conversation
    ADD CONSTRAINT project_chat_message_conversation_project___3af13f9a_foreign FOREIGN KEY (project_chat_message_id) REFERENCES public.project_chat_message(id) ON DELETE SET NULL;


--
-- Name: project_chat_message project_chat_message_project_chat_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_chat_message
    ADD CONSTRAINT project_chat_message_project_chat_id_foreign FOREIGN KEY (project_chat_id) REFERENCES public.project_chat(id) ON DELETE CASCADE;


--
-- Name: project_chat project_chat_project_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_chat
    ADD CONSTRAINT project_chat_project_id_foreign FOREIGN KEY (project_id) REFERENCES public.project(id) ON DELETE CASCADE;


--
-- Name: project_chat project_chat_user_created_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_chat
    ADD CONSTRAINT project_chat_user_created_foreign FOREIGN KEY (user_created) REFERENCES public.directus_users(id);


--
-- Name: project_chat project_chat_user_updated_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_chat
    ADD CONSTRAINT project_chat_user_updated_foreign FOREIGN KEY (user_updated) REFERENCES public.directus_users(id);


--
-- Name: project project_directus_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project
    ADD CONSTRAINT project_directus_user_id_foreign FOREIGN KEY (directus_user_id) REFERENCES public.directus_users(id) ON DELETE SET NULL;


--
-- Name: project_goal_revision project_goal_revision_project_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_goal_revision
    ADD CONSTRAINT project_goal_revision_project_id_foreign FOREIGN KEY (project_id) REFERENCES public.project(id) ON DELETE SET NULL;


--
-- Name: project_membership project_membership_granted_by_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_membership
    ADD CONSTRAINT project_membership_granted_by_foreign FOREIGN KEY (granted_by) REFERENCES public.app_user(id) ON DELETE SET NULL;


--
-- Name: project_membership project_membership_project_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_membership
    ADD CONSTRAINT project_membership_project_id_foreign FOREIGN KEY (project_id) REFERENCES public.project(id) ON DELETE CASCADE;


--
-- Name: project_membership project_membership_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_membership
    ADD CONSTRAINT project_membership_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.app_user(id) ON DELETE CASCADE;


--
-- Name: project project_methodology_version_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project
    ADD CONSTRAINT project_methodology_version_id_foreign FOREIGN KEY (methodology_version_id) REFERENCES public.methodology_version(id) ON DELETE SET NULL;


--
-- Name: project_report_metric project_report_metric_project_report_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_report_metric
    ADD CONSTRAINT project_report_metric_project_report_id_foreign FOREIGN KEY (project_report_id) REFERENCES public.project_report(id) ON DELETE SET NULL;


--
-- Name: project_report_notification_participants project_report_notification_participants_c__5f83ce3c_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_report_notification_participants
    ADD CONSTRAINT project_report_notification_participants_c__5f83ce3c_foreign FOREIGN KEY (conversation_id) REFERENCES public.conversation(id) ON DELETE SET NULL;


--
-- Name: project_report project_report_project_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_report
    ADD CONSTRAINT project_report_project_id_foreign FOREIGN KEY (project_id) REFERENCES public.project(id) ON DELETE SET NULL;


--
-- Name: project_report project_report_user_created_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_report
    ADD CONSTRAINT project_report_user_created_foreign FOREIGN KEY (user_created) REFERENCES public.directus_users(id) ON DELETE SET NULL;


--
-- Name: project_tag project_tag_project_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_tag
    ADD CONSTRAINT project_tag_project_id_foreign FOREIGN KEY (project_id) REFERENCES public.project(id) ON DELETE CASCADE;


--
-- Name: project_webhook project_webhook_project_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_webhook
    ADD CONSTRAINT project_webhook_project_id_foreign FOREIGN KEY (project_id) REFERENCES public.project(id) ON DELETE SET NULL;


--
-- Name: project_webhook project_webhook_user_created_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_webhook
    ADD CONSTRAINT project_webhook_user_created_foreign FOREIGN KEY (user_created) REFERENCES public.directus_users(id);


--
-- Name: project_webhook project_webhook_user_updated_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_webhook
    ADD CONSTRAINT project_webhook_user_updated_foreign FOREIGN KEY (user_updated) REFERENCES public.directus_users(id);


--
-- Name: project project_workspace_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project
    ADD CONSTRAINT project_workspace_id_foreign FOREIGN KEY (workspace_id) REFERENCES public.workspace(id) ON DELETE SET NULL;


--
-- Name: prompt_template prompt_template_user_created_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_template
    ADD CONSTRAINT prompt_template_user_created_foreign FOREIGN KEY (user_created) REFERENCES public.directus_users(id);


--
-- Name: prompt_template prompt_template_workspace_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_template
    ADD CONSTRAINT prompt_template_workspace_id_foreign FOREIGN KEY (workspace_id) REFERENCES public.workspace(id) ON DELETE CASCADE;


--
-- Name: recording_overage recording_overage_billing_account_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recording_overage
    ADD CONSTRAINT recording_overage_billing_account_id_foreign FOREIGN KEY (billing_account_id) REFERENCES public.billing_account(id) ON DELETE SET NULL;


--
-- Name: referral_ledger referral_ledger_created_by_staff_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_ledger
    ADD CONSTRAINT referral_ledger_created_by_staff_id_foreign FOREIGN KEY (created_by_staff_id) REFERENCES public.app_user(id) ON DELETE SET NULL;


--
-- Name: referral_ledger referral_ledger_partner_team_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_ledger
    ADD CONSTRAINT referral_ledger_partner_team_id_foreign FOREIGN KEY (partner_team_id) REFERENCES public.org(id) ON DELETE CASCADE;


--
-- Name: referral_ledger referral_ledger_workspace_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_ledger
    ADD CONSTRAINT referral_ledger_workspace_id_foreign FOREIGN KEY (workspace_id) REFERENCES public.workspace(id) ON DELETE CASCADE;


--
-- Name: support_access_event support_access_event_actor_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_access_event
    ADD CONSTRAINT support_access_event_actor_user_id_foreign FOREIGN KEY (actor_user_id) REFERENCES public.app_user(id) ON DELETE SET NULL;


--
-- Name: support_access_event support_access_event_staff_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_access_event
    ADD CONSTRAINT support_access_event_staff_user_id_foreign FOREIGN KEY (staff_user_id) REFERENCES public.app_user(id) ON DELETE SET NULL;


--
-- Name: support_access_event support_access_event_workspace_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_access_event
    ADD CONSTRAINT support_access_event_workspace_id_foreign FOREIGN KEY (workspace_id) REFERENCES public.workspace(id) ON DELETE SET NULL;


--
-- Name: support_access_request support_access_request_membership_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_access_request
    ADD CONSTRAINT support_access_request_membership_id_foreign FOREIGN KEY (membership_id) REFERENCES public.workspace_membership(id) ON DELETE SET NULL;


--
-- Name: support_access_request support_access_request_requested_by_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_access_request
    ADD CONSTRAINT support_access_request_requested_by_foreign FOREIGN KEY (requested_by) REFERENCES public.app_user(id) ON DELETE SET NULL;


--
-- Name: support_access_request support_access_request_resolved_by_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_access_request
    ADD CONSTRAINT support_access_request_resolved_by_foreign FOREIGN KEY (resolved_by) REFERENCES public.app_user(id) ON DELETE SET NULL;


--
-- Name: support_access_request support_access_request_workspace_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_access_request
    ADD CONSTRAINT support_access_request_workspace_id_foreign FOREIGN KEY (workspace_id) REFERENCES public.workspace(id) ON DELETE SET NULL;


--
-- Name: training_license training_license_app_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_license
    ADD CONSTRAINT training_license_app_user_id_foreign FOREIGN KEY (app_user_id) REFERENCES public.app_user(id) ON DELETE CASCADE;


--
-- Name: training_license training_license_granted_by_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_license
    ADD CONSTRAINT training_license_granted_by_foreign FOREIGN KEY (granted_by) REFERENCES public.app_user(id) ON DELETE SET NULL;


--
-- Name: training_license training_license_org_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_license
    ADD CONSTRAINT training_license_org_id_foreign FOREIGN KEY (org_id) REFERENCES public.org(id) ON DELETE CASCADE;


--
-- Name: training_license training_license_training_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_license
    ADD CONSTRAINT training_license_training_id_foreign FOREIGN KEY (training_id) REFERENCES public.training(id) ON DELETE SET NULL;


--
-- Name: training training_org_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training
    ADD CONSTRAINT training_org_id_foreign FOREIGN KEY (org_id) REFERENCES public.org(id) ON DELETE CASCADE;


--
-- Name: training training_requested_by_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training
    ADD CONSTRAINT training_requested_by_foreign FOREIGN KEY (requested_by) REFERENCES public.app_user(id) ON DELETE SET NULL;


--
-- Name: verification_topic verification_topic_project_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verification_topic
    ADD CONSTRAINT verification_topic_project_id_foreign FOREIGN KEY (project_id) REFERENCES public.project(id) ON DELETE SET NULL;


--
-- Name: verification_topic_translations verification_topic_translations_languages_code_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verification_topic_translations
    ADD CONSTRAINT verification_topic_translations_languages_code_foreign FOREIGN KEY (languages_code) REFERENCES public.languages(code) ON DELETE SET NULL;


--
-- Name: verification_topic_translations verification_topic_translations_verificati__34868e89_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verification_topic_translations
    ADD CONSTRAINT verification_topic_translations_verificati__34868e89_foreign FOREIGN KEY (verification_topic_key) REFERENCES public.verification_topic(key) ON DELETE SET NULL;


--
-- Name: verification_topic verification_topic_user_created_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verification_topic
    ADD CONSTRAINT verification_topic_user_created_foreign FOREIGN KEY (user_created) REFERENCES public.directus_users(id);


--
-- Name: verification_topic verification_topic_user_updated_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verification_topic
    ADD CONSTRAINT verification_topic_user_updated_foreign FOREIGN KEY (user_updated) REFERENCES public.directus_users(id);


--
-- Name: view view_project_analysis_run_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.view
    ADD CONSTRAINT view_project_analysis_run_id_foreign FOREIGN KEY (project_analysis_run_id) REFERENCES public.project_analysis_run(id) ON DELETE SET NULL;


--
-- Name: workspace workspace_billed_to_team_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace
    ADD CONSTRAINT workspace_billed_to_team_id_foreign FOREIGN KEY (billed_to_team_id) REFERENCES public.org(id) ON DELETE SET NULL;


--
-- Name: workspace workspace_billed_to_workspace_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace
    ADD CONSTRAINT workspace_billed_to_workspace_id_foreign FOREIGN KEY (billed_to_workspace_id) REFERENCES public.workspace(id) ON DELETE SET NULL;


--
-- Name: workspace workspace_billing_account_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace
    ADD CONSTRAINT workspace_billing_account_id_foreign FOREIGN KEY (billing_account_id) REFERENCES public.billing_account(id);


--
-- Name: workspace workspace_created_by_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace
    ADD CONSTRAINT workspace_created_by_foreign FOREIGN KEY (created_by) REFERENCES public.app_user(id) ON DELETE SET NULL;


--
-- Name: workspace workspace_effective_client_team_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace
    ADD CONSTRAINT workspace_effective_client_team_id_foreign FOREIGN KEY (effective_client_team_id) REFERENCES public.org(id) ON DELETE SET NULL;


--
-- Name: workspace workspace_handoff_target_team_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace
    ADD CONSTRAINT workspace_handoff_target_team_id_foreign FOREIGN KEY (handoff_target_team_id) REFERENCES public.org(id) ON DELETE SET NULL;


--
-- Name: workspace_invite workspace_invite_invited_by_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invite
    ADD CONSTRAINT workspace_invite_invited_by_foreign FOREIGN KEY (invited_by) REFERENCES public.app_user(id) ON DELETE SET NULL;


--
-- Name: workspace_invite workspace_invite_project_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invite
    ADD CONSTRAINT workspace_invite_project_id_foreign FOREIGN KEY (project_id) REFERENCES public.project(id) ON DELETE SET NULL;


--
-- Name: workspace_invite workspace_invite_workspace_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invite
    ADD CONSTRAINT workspace_invite_workspace_id_foreign FOREIGN KEY (workspace_id) REFERENCES public.workspace(id) ON DELETE CASCADE;


--
-- Name: workspace_membership workspace_membership_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_membership
    ADD CONSTRAINT workspace_membership_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.app_user(id) ON DELETE CASCADE;


--
-- Name: workspace_membership workspace_membership_workspace_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_membership
    ADD CONSTRAINT workspace_membership_workspace_id_foreign FOREIGN KEY (workspace_id) REFERENCES public.workspace(id) ON DELETE CASCADE;


--
-- Name: workspace workspace_org_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace
    ADD CONSTRAINT workspace_org_id_foreign FOREIGN KEY (org_id) REFERENCES public.org(id) ON DELETE CASCADE;


--
-- Name: workspace_request workspace_request_decided_by_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_request
    ADD CONSTRAINT workspace_request_decided_by_foreign FOREIGN KEY (decided_by) REFERENCES public.app_user(id) ON DELETE SET NULL;


--
-- Name: workspace_request workspace_request_org_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_request
    ADD CONSTRAINT workspace_request_org_id_foreign FOREIGN KEY (org_id) REFERENCES public.org(id) ON DELETE CASCADE;


--
-- Name: workspace_request workspace_request_requested_by_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_request
    ADD CONSTRAINT workspace_request_requested_by_foreign FOREIGN KEY (requested_by) REFERENCES public.app_user(id) ON DELETE CASCADE;


--
-- Name: workspace_request workspace_request_resulting_workspace_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_request
    ADD CONSTRAINT workspace_request_resulting_workspace_id_foreign FOREIGN KEY (resulting_workspace_id) REFERENCES public.workspace(id) ON DELETE SET NULL;


--
-- Name: workspace_request workspace_request_workspace_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_request
    ADD CONSTRAINT workspace_request_workspace_id_foreign FOREIGN KEY (workspace_id) REFERENCES public.workspace(id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--

\unrestrict parityfixture

