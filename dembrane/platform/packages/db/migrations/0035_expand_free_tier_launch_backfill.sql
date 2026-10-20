-- Free tier launch: count this period's existing usage into free_usage and stamp what it counted. Safe to run twice.
UPDATE "conversation" SET "is_over_cap" = false WHERE "is_over_cap" = true;
--> statement-breakpoint
-- Every non-sample project of a free workspace, with its pooled account and period (mirrors allowance account.ts and period.ts).
CREATE TEMP TABLE free_launch_project AS
WITH month AS (SELECT date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS start),
ws AS (
  SELECT w.id AS workspace_id,
         CASE WHEN own.org_id IS NULL AND pool.tier = 'free' THEN pool.id ELSE own.id END AS account_id
  FROM workspace w
  JOIN billing_account own ON own.id = w.billing_account_id AND own.tier = 'free'
  LEFT JOIN LATERAL (SELECT b.id, b.tier FROM billing_account b
    WHERE b.org_id = w.org_id AND b.deleted_at IS NULL
    ORDER BY b.created_at ASC NULLS LAST, b.id ASC LIMIT 1) pool ON true
),
acc AS (
  SELECT DISTINCT ws.account_id,
    CASE WHEN date_trunc('milliseconds', ba.downgraded_at) > month.start
          AND date_trunc('milliseconds', ba.downgraded_at) <= now()
         THEN date_trunc('milliseconds', ba.downgraded_at) ELSE month.start END AS period_start
  FROM ws JOIN billing_account ba ON ba.id = ws.account_id CROSS JOIN month
)
SELECT p.id AS project_id, acc.account_id, acc.period_start, month.start AS month_start
FROM project p JOIN ws ON ws.workspace_id = p.workspace_id
JOIN acc ON acc.account_id = ws.account_id CROSS JOIN month
WHERE NOT p.is_sample;
--> statement-breakpoint
ANALYZE free_launch_project;
--> statement-breakpoint
INSERT INTO free_usage (billing_account_id, period_start, key, amount)
SELECT f.account_id, f.period_start, 'audio_seconds', round(sum(coalesce(c.duration::float8, 0)))
FROM conversation c JOIN free_launch_project f ON f.project_id = c.project_id
WHERE c.created_at >= f.period_start
GROUP BY f.account_id, f.period_start
HAVING round(sum(coalesce(c.duration::float8, 0))) > 0
ON CONFLICT (billing_account_id, period_start, key) DO UPDATE SET amount = greatest(free_usage.amount, excluded.amount), updated_at = now();
--> statement-breakpoint
-- Unstamped chats with a user turn this period, newest latest turn first per account.
CREATE TEMP TABLE free_launch_chat AS
SELECT ch.id, f.account_id, f.period_start, f.month_start,
  row_number() OVER (PARTITION BY f.account_id ORDER BY t.last_at DESC, ch.id DESC) AS rn
FROM project_chat ch JOIN free_launch_project f ON f.project_id = ch.project_id
JOIN LATERAL (SELECT max(m.date_created) AS last_at FROM project_chat_message m
  WHERE m.project_chat_id = ch.id AND m.message_from = 'user' AND m.date_created >= f.period_start) t
  ON t.last_at IS NOT NULL
WHERE ch.free_period_start IS NULL;
--> statement-breakpoint
-- The 2 most recent (less any already claimed) are this period's; the rest freeze in the previous month.
UPDATE project_chat ch
SET free_period_start = CASE WHEN c.rn <= 2 - coalesce(k.claimed, 0) THEN c.period_start
  ELSE date_trunc('month', (c.month_start - interval '1 day') AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' END
FROM free_launch_chat c
LEFT JOIN (SELECT f.account_id, count(*) AS claimed
  FROM project_chat x JOIN free_launch_project f ON f.project_id = x.project_id
  WHERE x.free_period_start = f.period_start GROUP BY f.account_id) k ON k.account_id = c.account_id
WHERE ch.id = c.id;
--> statement-breakpoint
INSERT INTO free_usage (billing_account_id, period_start, key, amount)
SELECT f.account_id, f.period_start, 'chats', least(count(*), 2)
FROM project_chat ch JOIN free_launch_project f ON f.project_id = ch.project_id
WHERE ch.free_period_start = f.period_start
GROUP BY f.account_id, f.period_start
ON CONFLICT (billing_account_id, period_start, key) DO UPDATE SET amount = greatest(free_usage.amount, excluded.amount), updated_at = now();
--> statement-breakpoint
DROP TABLE free_launch_chat;
--> statement-breakpoint
-- Chats with no turn this period, first messaged before this month, freeze in the month of their first turn.
UPDATE project_chat ch
SET free_period_start = date_trunc('month', t.first_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
FROM free_launch_project f,
  (SELECT m.project_chat_id, min(m.date_created) AS first_at, max(m.date_created) AS last_at
    FROM project_chat_message m
    JOIN project_chat pc ON pc.id = m.project_chat_id
    JOIN free_launch_project fp ON fp.project_id = pc.project_id
    WHERE m.message_from = 'user' GROUP BY m.project_chat_id) t
WHERE f.project_id = ch.project_id AND t.project_chat_id = ch.id AND ch.free_period_start IS NULL
  AND t.first_at < f.month_start AND t.last_at < f.period_start;
--> statement-breakpoint
INSERT INTO free_usage (billing_account_id, period_start, key, amount)
SELECT f.account_id, f.period_start, 'reports', count(*)
FROM project_report r JOIN free_launch_project f ON f.project_id = r.project_id
WHERE r.kind = 'report' AND r.date_created >= f.period_start
  AND NOT (r.status = 'error' AND coalesce(r.content, '') = '')
GROUP BY f.account_id, f.period_start
ON CONFLICT (billing_account_id, period_start, key) DO UPDATE SET amount = greatest(free_usage.amount, excluded.amount), updated_at = now();
--> statement-breakpoint
UPDATE project_report r SET free_period_start = f.period_start
FROM free_launch_project f
WHERE f.project_id = r.project_id AND r.free_period_start IS NULL
  AND r.kind = 'report' AND r.date_created >= f.period_start
  AND NOT (r.status = 'error' AND coalesce(r.content, '') = '');
--> statement-breakpoint
INSERT INTO free_usage (billing_account_id, period_start, key, amount)
SELECT f.account_id, f.period_start, 'maps', count(*)
FROM analysis_run a JOIN free_launch_project f ON f.project_id = a.project_id
-- The map service's scope (map/src/service.ts requestRun: producer 'arguments', scope_key 'project').
JOIN analysis_scope s ON s.id = a.scope_id AND s.kind = 'producer'
  AND s.recipe_id = 'arguments' AND s.scope_key = 'project'
WHERE a.recipe_id = 'arguments' AND a.reused_run_id IS NULL AND a.created_at >= f.period_start
  -- Dependency runs (executor key `${key}:arguments@project`) are not map generations; generic-route runs without a client key can't be told apart.
  AND (a.idempotency_key IS NULL OR a.idempotency_key NOT LIKE '%:arguments@project')
GROUP BY f.account_id, f.period_start
ON CONFLICT (billing_account_id, period_start, key) DO UPDATE SET amount = greatest(free_usage.amount, excluded.amount), updated_at = now();
--> statement-breakpoint
-- Only successful runs ("run N: ...") are the ones the runtime stamps.
INSERT INTO free_usage (billing_account_id, period_start, key, amount)
SELECT f.account_id, f.period_start, 'popcorn_analyses', count(*)
FROM agent_loop_run lr
JOIN agent_loop l ON l.id = lr.loop_id
JOIN project_report pr ON pr.id = l.report_id AND pr.kind = 'popcorn'
JOIN free_launch_project f ON f.project_id = l.project_id
WHERE lr.status = 'ok' AND lr.detail LIKE 'run %' AND lr.started_at >= f.period_start
GROUP BY f.account_id, f.period_start
ON CONFLICT (billing_account_id, period_start, key) DO UPDATE SET amount = greatest(free_usage.amount, excluded.amount), updated_at = now();
--> statement-breakpoint
UPDATE agent_loop_run lr SET free_period_start = f.period_start
FROM agent_loop l
JOIN project_report pr ON pr.id = l.report_id AND pr.kind = 'popcorn'
JOIN free_launch_project f ON f.project_id = l.project_id
WHERE l.id = lr.loop_id AND lr.free_period_start IS NULL
  AND lr.status = 'ok' AND lr.detail LIKE 'run %' AND lr.started_at >= f.period_start;
--> statement-breakpoint
DROP TABLE free_launch_project;
