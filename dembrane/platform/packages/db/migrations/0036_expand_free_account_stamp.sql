ALTER TABLE "agent_loop_run" ADD COLUMN IF NOT EXISTS "free_account_id" uuid;--> statement-breakpoint
ALTER TABLE "project_report" ADD COLUMN IF NOT EXISTS "free_account_id" uuid;--> statement-breakpoint
-- Stamped rows take the account they resolve to now (mirrors 0035 and allowance account.ts); unresolved ones stay null.
CREATE TEMP TABLE free_stamp_account AS
SELECT p.id AS project_id,
       CASE WHEN own.org_id IS NULL AND pool.tier = 'free' THEN pool.id ELSE own.id END AS account_id
FROM project p
JOIN workspace w ON w.id = p.workspace_id
JOIN billing_account own ON own.id = w.billing_account_id AND own.tier = 'free'
LEFT JOIN LATERAL (SELECT b.id, b.tier FROM billing_account b
  WHERE b.org_id = w.org_id AND b.deleted_at IS NULL
  ORDER BY b.created_at ASC NULLS LAST, b.id ASC LIMIT 1) pool ON true;
--> statement-breakpoint
UPDATE project_report r SET free_account_id = f.account_id
FROM free_stamp_account f
WHERE f.project_id = r.project_id AND r.free_period_start IS NOT NULL AND r.free_account_id IS NULL;
--> statement-breakpoint
UPDATE agent_loop_run lr SET free_account_id = f.account_id
FROM agent_loop l
JOIN free_stamp_account f ON f.project_id = l.project_id
WHERE l.id = lr.loop_id AND lr.free_period_start IS NOT NULL AND lr.free_account_id IS NULL;
--> statement-breakpoint
DROP TABLE free_stamp_account;
