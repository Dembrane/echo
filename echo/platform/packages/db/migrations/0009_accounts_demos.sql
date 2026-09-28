-- Synthetic demos made in echo, and two indexes for the tasks summary read on every
-- dashboard load. Expand only: a new table and indexes on small tables.
CREATE TABLE "account_demo" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"input" json NOT NULL,
	"slug" text,
	"steps" json NOT NULL,
	"pages" json,
	"research" json,
	"research_markdown" text,
	"corpus" json,
	"seed" json,
	"offer_document_id" uuid,
	"attempt" integer DEFAULT 1 NOT NULL,
	"invited_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_demo_status_check" CHECK ("account_demo"."status" in ('queued', 'running', 'draft', 'failed', 'published'))
);
--> statement-breakpoint
ALTER TABLE "account_demo" ADD CONSTRAINT "account_demo_org_id_foreign" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_demo_created_at_index" ON "account_demo" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "org_membership_user_id_index" ON "org_membership" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "account_task_org_id_status_index" ON "account_task" USING btree ("org_id","status");