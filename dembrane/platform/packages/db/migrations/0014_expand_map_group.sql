CREATE TABLE "map_group" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"selection_key" varchar(64) NOT NULL,
	"members" json NOT NULL,
	"status" varchar(32) NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"title" text,
	"error" text,
	"model" varchar(255),
	"prompt_version" varchar(128),
	"requested_by" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "map_group" ADD CONSTRAINT "map_group_project_id_foreign" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "map_group_project_selection" ON "map_group" USING btree ("project_id","selection_key");