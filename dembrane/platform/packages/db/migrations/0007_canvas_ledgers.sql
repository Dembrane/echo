-- The canvas ledger columns echo main's code reads and writes (Directus migration
-- add_smart_loop_wave28_canvas_ledgers.py), which were never applied to the deployed
-- schema. Without them a canvas cannot keep its quotes, concepts, crux, story, board and
-- host items between ticks. Nullable json, so the release before this one is unaffected.
ALTER TABLE IF EXISTS "canvas_config_revision" ADD COLUMN IF NOT EXISTS "tabs" json;
--> statement-breakpoint
ALTER TABLE IF EXISTS "agent_loop" ADD COLUMN IF NOT EXISTS "canvas_tabs" json;
--> statement-breakpoint
ALTER TABLE IF EXISTS "agent_loop" ADD COLUMN IF NOT EXISTS "canvas_quotes_ledger" json;
--> statement-breakpoint
ALTER TABLE IF EXISTS "agent_loop" ADD COLUMN IF NOT EXISTS "canvas_concepts_ledger" json;
--> statement-breakpoint
ALTER TABLE IF EXISTS "agent_loop" ADD COLUMN IF NOT EXISTS "canvas_crux" json;
--> statement-breakpoint
ALTER TABLE IF EXISTS "agent_loop" ADD COLUMN IF NOT EXISTS "canvas_host_items" json;
--> statement-breakpoint
ALTER TABLE IF EXISTS "agent_loop" ADD COLUMN IF NOT EXISTS "canvas_story_slides" json;
--> statement-breakpoint
ALTER TABLE IF EXISTS "agent_loop" ADD COLUMN IF NOT EXISTS "canvas_host_guide" json;
--> statement-breakpoint
ALTER TABLE IF EXISTS "agent_loop" ADD COLUMN IF NOT EXISTS "canvas_board_cards" json;
