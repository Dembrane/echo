-- A demo contact released before releaseHeldContacts (packages/accounts/src/prospect.ts)
-- gave them a row in the demo's workspace is an organisation admin with no direct
-- membership there, so their workspace list and the organisation page leave the demo out
-- once its onboarding step is done. This gives each of them what a release gives now: the
-- demo's project pinned on the workspace card, and an admin row in the workspace. Only for
-- a released contact who is still a live admin or owner of the demo's organisation, a live
-- workspace of that same organisation (a shared staff demo workspace is not theirs), and a
-- person with no row in it at all, so someone who was removed stays removed. A pin is set
-- only where the project has none. Safe to run twice: the pin goes first, while the
-- missing row still marks who is owed one.
WITH "owed" AS (
  SELECT w."id" AS "workspace_id", d."seed"->'projects' AS "projects"
  FROM "account_demo" d
  JOIN "workspace" w ON w."id"::text = d."seed"->>'workspace_id'
    AND w."org_id" = d."org_id" AND w."deleted_at" IS NULL
  JOIN "app_user" au ON au."directus_user_id"::text = d."seed"->>'contact_user_id'
  WHERE d."seed"->>'contact_held' = 'false'
    AND json_typeof(d."seed"->'projects') = 'array'
    AND EXISTS (SELECT 1 FROM "org_membership" om WHERE om."org_id" = d."org_id"
      AND om."user_id" = au."id" AND om."deleted_at" IS NULL AND om."role" IN ('admin', 'owner'))
    AND NOT EXISTS (SELECT 1 FROM "workspace_membership" m
      WHERE m."workspace_id" = w."id" AND m."user_id" = au."id")
)
UPDATE "project" p SET "pin_order" = 1
FROM "owed" o CROSS JOIN LATERAL json_array_elements(o."projects") dp
WHERE p."id"::text = dp->>'project_id' AND p."workspace_id" = o."workspace_id"
  AND p."deleted_at" IS NULL AND p."pin_order" IS NULL;--> statement-breakpoint
INSERT INTO "workspace_membership" ("id", "workspace_id", "user_id", "role", "source")
SELECT DISTINCT ON (w."id", au."id") gen_random_uuid(), w."id", au."id", 'admin', 'direct'
FROM "account_demo" d
JOIN "workspace" w ON w."id"::text = d."seed"->>'workspace_id'
  AND w."org_id" = d."org_id" AND w."deleted_at" IS NULL
JOIN "app_user" au ON au."directus_user_id"::text = d."seed"->>'contact_user_id'
WHERE d."seed"->>'contact_held' = 'false'
  AND EXISTS (SELECT 1 FROM "org_membership" om WHERE om."org_id" = d."org_id"
    AND om."user_id" = au."id" AND om."deleted_at" IS NULL AND om."role" IN ('admin', 'owner'))
  AND NOT EXISTS (SELECT 1 FROM "workspace_membership" m
    WHERE m."workspace_id" = w."id" AND m."user_id" = au."id")
ORDER BY w."id", au."id";
