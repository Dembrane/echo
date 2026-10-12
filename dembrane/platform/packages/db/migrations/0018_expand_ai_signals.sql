CREATE TABLE "ai_signal" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"step" varchar(64) NOT NULL,
	"kind" varchar(32) NOT NULL,
	"value" real,
	"target_type" varchar(64) NOT NULL,
	"target_id" varchar(255) NOT NULL,
	"project_id" uuid,
	"conversation_id" uuid,
	"actor_kind" varchar(32) NOT NULL,
	"actor_id" varchar(255),
	"payload" json
);
--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "training_consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "training_consent_version" varchar(64);--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "ai_training" varchar(16);--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "ai_training_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "ai_training" varchar(16);--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "ai_training_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN "step" text;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN "prompt_ref" text;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN "prompt_version" text;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN "target_type" text;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN "target_id" text;--> statement-breakpoint
ALTER TABLE "ai_signal" ADD CONSTRAINT "ai_signal_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_signal" ADD CONSTRAINT "ai_signal_conversation_id_foreign" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_signal_target" ON "ai_signal" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "ai_signal_step_created" ON "ai_signal" USING btree ("step","created_at");--> statement-breakpoint
CREATE INDEX "model_call_target_idx" ON "model_call" USING btree ("target_type","target_id");