-- What Whisper's confidence retries did for a conversation, per stage: stretches found, requests sent again, how each ended. Numbers only.
CREATE TABLE "conversation_transcribe_retry" (
	"conversation_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"spans" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"improved" integer DEFAULT 0 NOT NULL,
	"kept" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_transcribe_retry_conversation_id_stage_pk" PRIMARY KEY("conversation_id","stage")
);
--> statement-breakpoint
ALTER TABLE "conversation_transcribe_retry" ADD CONSTRAINT "conversation_transcribe_retry_conversation_id_foreign" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;