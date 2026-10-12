CREATE TABLE "connector_connection" (
	"id" uuid PRIMARY KEY NOT NULL,
	"app_user_id" uuid NOT NULL,
	"provider" varchar(32) NOT NULL,
	"account_id" varchar(255) NOT NULL,
	"account_name" varchar(255),
	"external_user_id" varchar(255),
	"access_token" text NOT NULL,
	"refresh_token" text,
	"expires_at" timestamp with time zone,
	"scope" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_connection_user_account" UNIQUE("app_user_id","provider","account_id")
);
--> statement-breakpoint
CREATE TABLE "connector_source" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"connection_id" uuid,
	"provider" varchar(32) NOT NULL,
	"external_id" varchar(255) NOT NULL,
	"name" text,
	"url" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"voice" varchar(32) NOT NULL,
	"created_by" uuid,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"error" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_source_project_external" UNIQUE("project_id","provider","external_id")
);
--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "voice" varchar(32);--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "origin" jsonb;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "connector_source_id" uuid;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "external_ref" varchar(255);--> statement-breakpoint
ALTER TABLE "connector_connection" ADD CONSTRAINT "connector_connection_app_user_id_foreign" FOREIGN KEY ("app_user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_source" ADD CONSTRAINT "connector_source_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_source" ADD CONSTRAINT "connector_source_connection_id_foreign" FOREIGN KEY ("connection_id") REFERENCES "public"."connector_connection"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connector_source_last_synced" ON "connector_source" USING btree ("last_synced_at");--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_connector_source_id_foreign" FOREIGN KEY ("connector_source_id") REFERENCES "public"."connector_source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_connector_source_ref" ON "conversation" USING btree ("connector_source_id","external_ref") WHERE connector_source_id is not null;