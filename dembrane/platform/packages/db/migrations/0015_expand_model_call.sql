CREATE TABLE "model_call" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"service" text NOT NULL,
	"operation" text,
	"request_id" text,
	"model_group" text NOT NULL,
	"model" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"finish_reason" text,
	"attempt" integer NOT NULL,
	"fallback" boolean DEFAULT false NOT NULL,
	"ms" integer NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer
);
--> statement-breakpoint
CREATE INDEX "model_call_started_at_idx" ON "model_call" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "processing_status_timestamp_idx" ON "processing_status" USING btree ("timestamp");--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS "obs";--> statement-breakpoint
COMMENT ON SCHEMA "obs" IS 'Aggregate views for dashboards: counts, durations and sizes per Amsterdam day, never text or people. Operations grant a read-only role (grafana_obs) this schema and nothing else, with default privileges so later views are covered.';--> statement-breakpoint
CREATE OR REPLACE VIEW "obs"."day_conversations" AS
SELECT (created_at AT TIME ZONE 'Europe/Amsterdam')::date AS day,
       count(*)::int AS created,
       (count(*) FILTER (WHERE is_finished))::int AS finished,
       (count(*) FILTER (WHERE deleted_at IS NOT NULL))::int AS deleted,
       coalesce(sum(duration), 0)::double precision AS seconds_recorded,
       count(DISTINCT project_id)::int AS projects,
       (count(*) FILTER (WHERE source = 'PORTAL_AUDIO'))::int AS portal_audio,
       (count(*) FILTER (WHERE source = 'DASHBOARD_UPLOAD'))::int AS uploads,
       (count(*) FILTER (WHERE source = 'GO_IOS'))::int AS go_ios
FROM conversation
WHERE created_at >= now() - interval '35 days'
GROUP BY 1;--> statement-breakpoint
CREATE OR REPLACE VIEW "obs"."day_chunks" AS
SELECT ("timestamp" AT TIME ZONE 'Europe/Amsterdam')::date AS day,
       count(*)::int AS chunks,
       count(DISTINCT conversation_id)::int AS conversations,
       (count(*) FILTER (WHERE error IS NOT NULL))::int AS errors,
       (count(*) FILTER (WHERE source = 'PORTAL_AUDIO'))::int AS portal_audio
FROM conversation_chunk
WHERE "timestamp" >= now() - interval '35 days'
GROUP BY 1;--> statement-breakpoint
CREATE OR REPLACE VIEW "obs"."minute_chunks" AS
SELECT date_trunc('minute', "timestamp") AS minute,
       count(*)::int AS chunks,
       count(DISTINCT conversation_id)::int AS conversations,
       (count(*) FILTER (WHERE error IS NOT NULL))::int AS errors
FROM conversation_chunk
WHERE "timestamp" >= now() - interval '7 days'
GROUP BY 1;--> statement-breakpoint
CREATE OR REPLACE VIEW "obs"."day_pipeline" AS
SELECT ("timestamp" AT TIME ZONE 'Europe/Amsterdam')::date AS day,
       event,
       count(*)::int AS n,
       round(avg(duration_ms))::int AS avg_ms,
       (percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms))::int AS p50_ms,
       (percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms))::int AS p95_ms,
       max(duration_ms) AS max_ms
FROM processing_status
WHERE "timestamp" >= now() - interval '35 days'
GROUP BY 1, 2;--> statement-breakpoint
CREATE OR REPLACE VIEW "obs"."minute_pipeline" AS
SELECT date_trunc('minute', "timestamp") AS minute,
       event,
       count(*)::int AS n,
       round(avg(duration_ms))::int AS avg_ms,
       max(duration_ms) AS max_ms
FROM processing_status
WHERE "timestamp" >= now() - interval '7 days'
GROUP BY 1, 2;--> statement-breakpoint
CREATE OR REPLACE VIEW "obs"."day_reports" AS
SELECT (date_created AT TIME ZONE 'Europe/Amsterdam')::date AS day,
       kind,
       status,
       count(*)::int AS n
FROM project_report
WHERE date_created >= now() - interval '35 days'
GROUP BY 1, 2, 3;--> statement-breakpoint
CREATE OR REPLACE VIEW "obs"."day_chats" AS
SELECT coalesce(m.day, c.day) AS day,
       coalesce(c.chats_created, 0) AS chats_created,
       coalesce(m.messages, 0) AS messages,
       coalesce(m.user_messages, 0) AS user_messages,
       coalesce(m.assistant_messages, 0) AS assistant_messages,
       coalesce(m.active_chats, 0) AS active_chats
FROM (SELECT (date_created AT TIME ZONE 'Europe/Amsterdam')::date AS day,
             count(*)::int AS messages,
             (count(*) FILTER (WHERE message_from = 'user'))::int AS user_messages,
             (count(*) FILTER (WHERE message_from <> 'user'))::int AS assistant_messages,
             count(DISTINCT project_chat_id)::int AS active_chats
      FROM project_chat_message
      WHERE date_created >= now() - interval '35 days'
      GROUP BY 1) m
FULL OUTER JOIN (SELECT (date_created AT TIME ZONE 'Europe/Amsterdam')::date AS day,
                        count(*)::int AS chats_created
                 FROM project_chat
                 WHERE date_created >= now() - interval '35 days'
                 GROUP BY 1) c ON c.day = m.day;--> statement-breakpoint
CREATE OR REPLACE VIEW "obs"."day_assistant" AS
SELECT (created_at AT TIME ZONE 'Europe/Amsterdam')::date AS day,
       count(*)::int AS runs,
       (count(*) FILTER (WHERE status = 'completed'))::int AS completed,
       (count(*) FILTER (WHERE status NOT IN ('completed', 'running', 'queued')))::int AS not_completed,
       round(avg(extract(epoch FROM (completed_at - started_at))))::int AS avg_seconds
FROM project_agentic_run
WHERE created_at >= now() - interval '35 days'
GROUP BY 1;--> statement-breakpoint
CREATE OR REPLACE VIEW "obs"."day_model_calls" AS
SELECT (started_at AT TIME ZONE 'Europe/Amsterdam')::date AS day,
       service,
       coalesce(operation, '(none)') AS operation,
       model_group,
       model,
       kind,
       count(*)::int AS calls,
       (count(*) FILTER (WHERE status = 'error'))::int AS errors,
       (count(*) FILTER (WHERE status = 'ok' AND finish_reason IN ('safety', 'content-filter', 'recitation', 'blocklist', 'prohibited_content', 'spii')))::int AS refusals,
       (count(*) FILTER (WHERE status = 'ok' AND finish_reason IN ('length', 'max_tokens')))::int AS truncated,
       (count(*) FILTER (WHERE attempt > 1))::int AS retries,
       (count(*) FILTER (WHERE fallback))::int AS fallbacks,
       coalesce(sum(input_tokens), 0)::bigint AS input_tokens,
       coalesce(sum(output_tokens), 0)::bigint AS output_tokens,
       round(avg(input_tokens))::int AS avg_input_tokens,
       max(input_tokens) AS max_input_tokens,
       round(avg(ms))::int AS avg_ms,
       (percentile_cont(0.5) WITHIN GROUP (ORDER BY ms))::int AS p50_ms,
       (percentile_cont(0.95) WITHIN GROUP (ORDER BY ms))::int AS p95_ms,
       max(ms) AS max_ms
FROM model_call
WHERE started_at >= now() - interval '35 days'
GROUP BY 1, 2, 3, 4, 5, 6;--> statement-breakpoint
CREATE OR REPLACE VIEW "obs"."minute_model_calls" AS
SELECT date_trunc('minute', started_at) AS minute,
       service,
       coalesce(operation, '(none)') AS operation,
       model_group,
       model,
       count(*)::int AS calls,
       (count(*) FILTER (WHERE status = 'error'))::int AS errors,
       coalesce(sum(input_tokens), 0)::bigint AS input_tokens,
       coalesce(sum(output_tokens), 0)::bigint AS output_tokens,
       round(avg(ms))::int AS avg_ms,
       max(ms) AS max_ms
FROM model_call
WHERE started_at >= now() - interval '7 days'
GROUP BY 1, 2, 3, 4, 5;--> statement-breakpoint
CREATE OR REPLACE VIEW "obs"."model_calls" AS
SELECT started_at, service, coalesce(operation, '(none)') AS operation, model_group, model, kind,
       status, error, finish_reason, attempt, fallback, ms, input_tokens, output_tokens
FROM model_call
WHERE started_at >= now() - interval '7 days';--> statement-breakpoint
-- A chunk's timestamp comes from the client clock and can sit in the future; the indexed
-- timestamp narrows the scan, created_at decides what counts as now.
CREATE OR REPLACE VIEW "obs"."live_now" AS
SELECT (SELECT count(*) FROM platform_presence WHERE kind = 'liveness' AND expires_at > now())::int AS participants_live,
       (SELECT count(*) FROM platform_presence WHERE kind = 'active' AND expires_at > now())::int AS conversations_active,
       (SELECT count(DISTINCT conversation_id) FROM conversation_chunk WHERE "timestamp" > now() - interval '10 minutes' AND "timestamp" < now() + interval '10 minutes' AND created_at > now() - interval '10 minutes')::int AS conversations_with_audio_10m,
       (SELECT count(*) FROM conversation WHERE is_finished = false AND deleted_at IS NULL AND created_at > now() - interval '24 hours')::int AS unfinished_24h,
       (SELECT count(*) FROM conversation_chunk WHERE "timestamp" > now() - interval '1 hour' AND "timestamp" < now() + interval '10 minutes' AND created_at > now() - interval '1 hour' AND transcript IS NULL AND error IS NULL)::int AS chunks_waiting_1h;
