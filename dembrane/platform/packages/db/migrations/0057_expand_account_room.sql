-- The data room (who does what): the people an organisation's account room knows, with
-- their labels and room access, and the hints waved away per organisation. New tables
-- only: nothing reads them before this release. Safe to run twice.
CREATE TABLE IF NOT EXISTS "account_room_hint" (
	"org_id" uuid NOT NULL,
	"label" text NOT NULL,
	"dismissed_by" uuid,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_room_hint_org_id_label_pk" PRIMARY KEY("org_id","label"),
	CONSTRAINT "account_room_hint_label_check" CHECK ("account_room_hint"."label" in ('go_ahead', 'it_security', 'privacy_ai', 'contract_purchasing'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "account_room_person" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"email" text NOT NULL,
	"app_user_id" uuid,
	"name" text NOT NULL,
	"labels" text[] DEFAULT '{}'::text[] NOT NULL,
	"other" text,
	"access_granted_at" timestamp with time zone,
	"invited_by" uuid,
	"org_invite_id" uuid,
	"labels_answered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_room_person_org_id_email_unique" UNIQUE("org_id","email"),
	CONSTRAINT "account_room_person_labels_check" CHECK ("account_room_person"."labels" <@ array['go_ahead', 'rollout', 'it_security', 'privacy_ai', 'contract_purchasing', 'staff_stakeholders']::text[]),
	CONSTRAINT "account_room_person_other_check" CHECK ("account_room_person"."other" is null or char_length("account_room_person"."other") <= 80)
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "account_room_hint" ADD CONSTRAINT "account_room_hint_org_id_foreign" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "account_room_hint" ADD CONSTRAINT "account_room_hint_dismissed_by_foreign" FOREIGN KEY ("dismissed_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "account_room_person" ADD CONSTRAINT "account_room_person_org_id_foreign" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "account_room_person" ADD CONSTRAINT "account_room_person_app_user_id_foreign" FOREIGN KEY ("app_user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "account_room_person" ADD CONSTRAINT "account_room_person_invited_by_foreign" FOREIGN KEY ("invited_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "account_room_person" ADD CONSTRAINT "account_room_person_org_invite_id_foreign" FOREIGN KEY ("org_invite_id") REFERENCES "public"."org_invite"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "account_room_person_org_id_app_user_id_index" ON "account_room_person" USING btree ("org_id","app_user_id");