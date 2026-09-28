CREATE TABLE "staff_audit_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"staff_user_id" uuid NOT NULL,
	"permission" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"detail" json,
	"request_id" text
);
--> statement-breakpoint
CREATE INDEX "staff_audit_event_staff_user_id_index" ON "staff_audit_event" USING btree ("staff_user_id");--> statement-breakpoint
CREATE INDEX "staff_audit_event_target_index" ON "staff_audit_event" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "staff_audit_event_created_at_index" ON "staff_audit_event" USING btree ("created_at");