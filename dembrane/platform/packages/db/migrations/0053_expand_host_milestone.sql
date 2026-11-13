-- Product milestones a host reached, once each: the claim behind server_first_value_reached. Safe to run twice.
CREATE TABLE IF NOT EXISTS "host_milestone" (
	"directus_user_id" uuid NOT NULL,
	"milestone" text NOT NULL,
	"project_id" uuid,
	"reached_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "host_milestone_directus_user_id_milestone_pk" PRIMARY KEY("directus_user_id","milestone")
);--> statement-breakpoint
-- Hosts who reached first value before the event existed keep it: their first portal or upload
-- conversation in a project they created, sample projects left out. Without this their next
-- conversation would count as a first.
INSERT INTO "host_milestone" ("directus_user_id", "milestone", "project_id", "reached_at")
SELECT DISTINCT ON (p."directus_user_id") p."directus_user_id", 'first_value', p."id", coalesce(c."created_at", now())
FROM "conversation" c
JOIN "project" p ON p."id" = c."project_id"
WHERE p."directus_user_id" IS NOT NULL
	AND p."is_sample" = false
	AND (c."source" IS NULL OR c."source" <> 'CLONE')
ORDER BY p."directus_user_id", c."created_at" ASC NULLS LAST
ON CONFLICT DO NOTHING;
