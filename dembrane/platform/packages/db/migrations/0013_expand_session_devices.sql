CREATE TABLE "auth_sign_in_overlap" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"device_id" text,
	"other_sessions" integer NOT NULL,
	"other_devices" integer NOT NULL,
	"other_last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"replaced_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "auth_session" ADD COLUMN "device_id" text;--> statement-breakpoint
ALTER TABLE "auth_session" ADD COLUMN "held" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_session" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_sign_in_overlap" ADD CONSTRAINT "auth_sign_in_overlap_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_sign_in_overlap_user_id_index" ON "auth_sign_in_overlap" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sign_in_overlap_session_id_index" ON "auth_sign_in_overlap" USING btree ("session_id");