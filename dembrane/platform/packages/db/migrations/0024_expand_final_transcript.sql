-- The whole recording transcribed again once a conversation is finished, one row per provider.
-- Additive: nothing reads it until the final pass is switched on, and the live chunk text stays.
CREATE TABLE "conversation_final_transcript" (
	"conversation_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"chunk_hash" text NOT NULL,
	"is_record" boolean DEFAULT false NOT NULL,
	"text" text NOT NULL,
	"sentences" jsonb,
	"audio_seconds" real,
	"usage" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_final_transcript_conversation_id_provider_pk" PRIMARY KEY("conversation_id","provider")
);
--> statement-breakpoint
ALTER TABLE "conversation_final_transcript" ADD CONSTRAINT "conversation_final_transcript_conversation_id_foreign" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;

--> statement-breakpoint
-- The transcript people read: the flagged row, only while its chunk list is still the
-- conversation's own (same hash as the pipeline's hand-over: sha256 of the sorted chunk
-- ids, first 16 hex). Readers select from this view and fall back to the chunks when it
-- has no row, so a conversation that gains audio goes back to its live text at once.
CREATE VIEW "conversation_record_transcript" AS
SELECT f.conversation_id, f.provider, f.model, f.text, f.sentences, f.audio_seconds, f.updated_at
FROM conversation_final_transcript f
WHERE f.is_record
  AND f.chunk_hash = (
    SELECT left(encode(sha256(convert_to(string_agg(c.id::text, ',' ORDER BY c.id), 'UTF8')), 'hex'), 16)
    FROM conversation_chunk c WHERE c.conversation_id = f.conversation_id);
