-- The backend's AI feature rules as a table, filled when the worker starts, and obs.ai_feature(), which names an operation as the backend does. Safe to run twice.
CREATE TABLE IF NOT EXISTS "ai_feature_rule" (
	"position" integer PRIMARY KEY NOT NULL,
	"pattern" text NOT NULL,
	"feature_group" text NOT NULL,
	"group_label" text NOT NULL,
	"feature" text NOT NULL
);
--> statement-breakpoint
REVOKE ALL ON public.ai_feature_rule FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION obs.ai_feature(operation text) RETURNS TABLE (feature_group text, group_label text, feature text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT m.feature_group, m.group_label, m.feature FROM (
		SELECT r.position::bigint AS rank, r.feature_group, r.group_label, r.feature FROM public.ai_feature_rule r WHERE operation ~ r.pattern
		UNION ALL
		SELECT 4294967296, 'other', 'Other', coalesce(nullif(operation, ''), 'Unlabelled')
	) m ORDER BY m.rank LIMIT 1
$$;
