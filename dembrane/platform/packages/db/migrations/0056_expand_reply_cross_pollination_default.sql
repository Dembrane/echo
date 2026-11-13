-- Cross-pollination is on by default (ECHO-1052): every project, new or existing, keeps
-- Explore reading the project's other conversations, as it did before the switch. 0055 ran
-- with default false on PR preview databases, which are kept between deploys, so this sets
-- the default and turns every row on, and previews converge with a fresh database. Safe to
-- run twice.
ALTER TABLE "project" ALTER COLUMN "is_get_reply_cross_pollination_enabled" SET DEFAULT true;--> statement-breakpoint
UPDATE "project" SET "is_get_reply_cross_pollination_enabled" = true WHERE "is_get_reply_cross_pollination_enabled" = false;
