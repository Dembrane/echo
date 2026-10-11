-- A sample project (project.is_sample, packages/samples) is a copy dembrane seeds into a
-- workspace: invented conversations with their chunks, and a chat with two seeded turns.
-- The views that count conversations, chunks and chats leave sample projects out, so a
-- seeded copy is never shown as use. The columns of every view are unchanged.
CREATE OR REPLACE VIEW "obs"."day_conversations" AS
SELECT (c.created_at AT TIME ZONE 'Europe/Amsterdam')::date AS day,
       count(*)::int AS created,
       (count(*) FILTER (WHERE c.is_finished))::int AS finished,
       (count(*) FILTER (WHERE c.deleted_at IS NOT NULL))::int AS deleted,
       coalesce(sum(c.duration), 0)::double precision AS seconds_recorded,
       count(DISTINCT c.project_id)::int AS projects,
       (count(*) FILTER (WHERE c.source = 'PORTAL_AUDIO'))::int AS portal_audio,
       (count(*) FILTER (WHERE c.source = 'DASHBOARD_UPLOAD'))::int AS uploads,
       (count(*) FILTER (WHERE c.source = 'GO_IOS'))::int AS go_ios
FROM conversation c
WHERE c.created_at >= now() - interval '35 days'
  AND NOT EXISTS (SELECT 1 FROM project p WHERE p.id = c.project_id AND p.is_sample)
GROUP BY 1;--> statement-breakpoint
CREATE OR REPLACE VIEW "obs"."day_chunks" AS
SELECT (k."timestamp" AT TIME ZONE 'Europe/Amsterdam')::date AS day,
       count(*)::int AS chunks,
       count(DISTINCT k.conversation_id)::int AS conversations,
       (count(*) FILTER (WHERE k.error IS NOT NULL))::int AS errors,
       (count(*) FILTER (WHERE k.source = 'PORTAL_AUDIO'))::int AS portal_audio
FROM conversation_chunk k
WHERE k."timestamp" >= now() - interval '35 days'
  AND NOT EXISTS (SELECT 1 FROM conversation c JOIN project p ON p.id = c.project_id
                  WHERE c.id = k.conversation_id AND p.is_sample)
GROUP BY 1;--> statement-breakpoint
CREATE OR REPLACE VIEW "obs"."minute_chunks" AS
SELECT date_trunc('minute', k."timestamp") AS minute,
       count(*)::int AS chunks,
       count(DISTINCT k.conversation_id)::int AS conversations,
       (count(*) FILTER (WHERE k.error IS NOT NULL))::int AS errors
FROM conversation_chunk k
WHERE k."timestamp" >= now() - interval '7 days'
  AND NOT EXISTS (SELECT 1 FROM conversation c JOIN project p ON p.id = c.project_id
                  WHERE c.id = k.conversation_id AND p.is_sample)
GROUP BY 1;--> statement-breakpoint
CREATE OR REPLACE VIEW "obs"."day_chats" AS
SELECT coalesce(m.day, c.day) AS day,
       coalesce(c.chats_created, 0) AS chats_created,
       coalesce(m.messages, 0) AS messages,
       coalesce(m.user_messages, 0) AS user_messages,
       coalesce(m.assistant_messages, 0) AS assistant_messages,
       coalesce(m.active_chats, 0) AS active_chats
FROM (SELECT (msg.date_created AT TIME ZONE 'Europe/Amsterdam')::date AS day,
             count(*)::int AS messages,
             (count(*) FILTER (WHERE msg.message_from = 'user'))::int AS user_messages,
             (count(*) FILTER (WHERE msg.message_from <> 'user'))::int AS assistant_messages,
             count(DISTINCT msg.project_chat_id)::int AS active_chats
      FROM project_chat_message msg
      WHERE msg.date_created >= now() - interval '35 days'
        AND NOT EXISTS (SELECT 1 FROM project_chat pc JOIN project p ON p.id = pc.project_id
                        WHERE pc.id = msg.project_chat_id AND p.is_sample)
      GROUP BY 1) m
FULL OUTER JOIN (SELECT (pc.date_created AT TIME ZONE 'Europe/Amsterdam')::date AS day,
                        count(*)::int AS chats_created
                 FROM project_chat pc
                 WHERE pc.date_created >= now() - interval '35 days'
                   AND NOT EXISTS (SELECT 1 FROM project p WHERE p.id = pc.project_id AND p.is_sample)
                 GROUP BY 1) c ON c.day = m.day;
