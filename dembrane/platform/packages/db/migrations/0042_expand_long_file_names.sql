-- A chunk's path and an upload's conversation name carry the file's name, which has no length
-- limit: a long one overflowed varchar(255) and the upload failed after the file arrived.
-- varchar to text rewrites no rows. Safe to run twice.
ALTER TABLE "conversation" ALTER COLUMN "participant_name" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "conversation" ALTER COLUMN "participant_name" SET DEFAULT NULL;--> statement-breakpoint
ALTER TABLE "conversation_chunk" ALTER COLUMN "path" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "conversation_chunk" ALTER COLUMN "path" SET DEFAULT NULL;