-- The seed (packages/accounts/src/demo/build.ts) now makes the @dembrane.com staff member
-- who built a demo an admin of the demo's own workspace, through joinDemoWorkspace
-- (packages/accounts/src/prospect.ts). This gives the builders of demos seeded before that
-- the same row, under the same rules. Only a demo whose seed ran (seed->>'workspace_id' is
-- set), in any status, as the seed adds the row whatever happens after it; a live
-- workspace of the demo's own live organisation, so a shared staff demo workspace (in
-- staff's organisation, not the demo's) and a deleted workspace or organisation get
-- nothing; a builder whose app user address ends in @dembrane.com in any case, as
-- isStaffEmail reads it (lower, not trimmed); not the demo's contact, who joins at hand-over
-- or release; and a person with no row in that workspace at all, so someone who was removed
-- stays removed. A held workspace stays held: the row opens it to the builder alone and
-- takes no seat. One row per workspace and builder, however many demos they made there.
-- Safe to run twice. No account_event is written: the seed's
-- staff_member_added_to_workspace trace has no twin here.
INSERT INTO "workspace_membership" ("id", "workspace_id", "user_id", "role", "source")
SELECT DISTINCT ON (w."id", au."id") gen_random_uuid(), w."id", au."id", 'admin', 'direct'
FROM "account_demo" d
JOIN "org" o ON o."id" = d."org_id" AND o."deleted_at" IS NULL
JOIN "workspace" w ON w."id"::text = d."seed"->>'workspace_id'
  AND w."org_id" = d."org_id" AND w."deleted_at" IS NULL
JOIN "app_user" au ON au."directus_user_id" = d."created_by"
WHERE lower(au."email") LIKE '%@dembrane.com'
  AND d."created_by"::text IS DISTINCT FROM d."seed"->>'contact_user_id'
  AND NOT EXISTS (SELECT 1 FROM "workspace_membership" m
    WHERE m."workspace_id" = w."id" AND m."user_id" = au."id")
ORDER BY w."id", au."id";
