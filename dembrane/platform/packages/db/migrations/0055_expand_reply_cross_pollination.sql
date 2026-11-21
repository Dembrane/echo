-- Whether Explore may read the project's other conversations (ECHO-1052). Safe to run twice.
-- A constant default rewrites no rows: every existing project starts with it off.
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "is_get_reply_cross_pollination_enabled" boolean DEFAULT false NOT NULL;
