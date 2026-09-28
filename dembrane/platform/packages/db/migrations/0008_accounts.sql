-- Customer accounts (docs/accounts.md). Expand only: new tables, and nullable columns on
-- org and billing_account, so the release before this one reads and writes as before.
CREATE TABLE "account_document" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"supersedes_id" uuid,
	"reference" text,
	"template" text,
	"content" json,
	"body" text NOT NULL,
	"file_key" text,
	"page_count" integer,
	"sha256" text,
	"requires_signature" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"terms_text_id" uuid,
	"sla_text_id" uuid,
	"dpa_text_id" uuid,
	"lines" json,
	"subtotal_cents" bigint,
	"vat_cents" bigint,
	"total_cents" bigint,
	"currency" text,
	"valid_until" date,
	"external_ref" text,
	"exact_id" text,
	"issued_on" date,
	"due_on" date,
	"invoice_status" text,
	"paid_at" timestamp with time zone,
	"payment_url" text,
	"payment_reference" text,
	"signer_email" text,
	"signer_name" text,
	"signer_role" text,
	"signer_invited_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"viewed_at" timestamp with time zone,
	"signed_at" timestamp with time zone,
	"declined_at" timestamp with time zone,
	"decline_reason" text,
	"voided_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_document_exact_id_unique" UNIQUE("exact_id"),
	CONSTRAINT "account_document_kind_check" CHECK ("account_document"."kind" in ('offer', 'dpa', 'invoice', 'other')),
	CONSTRAINT "account_document_status_check" CHECK ("account_document"."status" in ('draft', 'sent', 'viewed', 'signed', 'declined', 'void')),
	CONSTRAINT "account_document_language_check" CHECK ("account_document"."language" in ('en', 'nl')),
	CONSTRAINT "account_document_invoice_status_check" CHECK ("account_document"."invoice_status" is null or "account_document"."invoice_status" in ('open', 'paid', 'overdue', 'void')),
	CONSTRAINT "account_document_currency_check" CHECK ("account_document"."currency" is null or "account_document"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "account_document_field" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"page" integer NOT NULL,
	"x" double precision NOT NULL,
	"y" double precision NOT NULL,
	"width" double precision NOT NULL,
	"height" double precision NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"signer_role" text DEFAULT 'signer' NOT NULL,
	"key" text,
	"sort" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "account_document_field_kind_check" CHECK ("account_document_field"."kind" in ('signature', 'initials', 'name', 'role', 'date', 'text', 'checkbox')),
	CONSTRAINT "account_document_field_box_check" CHECK ("account_document_field"."page" >= 1 and "account_document_field"."x" between 0 and 1 and "account_document_field"."y" between 0 and 1 and "account_document_field"."width" between 0 and 1 and "account_document_field"."height" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "account_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_user_id" uuid,
	"type" text NOT NULL,
	"subject_type" text,
	"subject_id" text,
	"detail" json,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_signature" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"document_version" integer NOT NULL,
	"signer_user_id" uuid NOT NULL,
	"typed_name" text NOT NULL,
	"typed_role" text,
	"email" text NOT NULL,
	"organisation" text NOT NULL,
	"address" text,
	"vat_number" text,
	"dpa_authorised" boolean NOT NULL,
	"sha256" text NOT NULL,
	"field_values" json NOT NULL,
	"method" text NOT NULL,
	"image_key" text NOT NULL,
	"image_sha256" text NOT NULL,
	"initials_image_key" text,
	"signed_at" timestamp with time zone NOT NULL,
	"ip" text,
	"user_agent" text,
	"confirmation_text" text NOT NULL,
	"signed_pdf_key" text NOT NULL,
	"signed_pdf_sha256" text NOT NULL,
	CONSTRAINT "account_signature_document_id_unique" UNIQUE("document_id"),
	CONSTRAINT "account_signature_method_check" CHECK ("account_signature"."method" in ('drawn', 'typed', 'uploaded'))
);
--> statement-breakpoint
CREATE TABLE "account_task" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"kind" text DEFAULT 'generic' NOT NULL,
	"document_id" uuid,
	"unlock_on_document_id" uuid,
	"due_on" date,
	"status" text DEFAULT 'open' NOT NULL,
	"opened_at" timestamp with time zone,
	"response_text" text,
	"response_file_key" text,
	"response_file_name" text,
	"submitted_at" timestamp with time zone,
	"submitted_by" uuid,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"review_note" text,
	"reminder_interval_days" integer,
	"next_reminder_at" timestamp with time zone,
	"reminders_sent" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_task_kind_check" CHECK ("account_task"."kind" in ('sign', 'billing_details', 'upload', 'generic')),
	CONSTRAINT "account_task_status_check" CHECK ("account_task"."status" in ('locked', 'open', 'submitted', 'done', 'changes_requested', 'withdrawn')),
	CONSTRAINT "account_task_reminder_interval_check" CHECK ("account_task"."reminder_interval_days" is null or "account_task"."reminder_interval_days" between 1 and 365)
);
--> statement-breakpoint
CREATE TABLE "account_ticket" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"status" text DEFAULT 'waiting_on_dembrane' NOT NULL,
	"opened_by" uuid,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_ticket_status_check" CHECK ("account_ticket"."status" in ('open', 'waiting_on_customer', 'waiting_on_dembrane', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "account_ticket_message" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ticket_id" uuid NOT NULL,
	"author_user_id" uuid,
	"from_staff" boolean DEFAULT false NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legal_text" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"version" text NOT NULL,
	"effective_on" date,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"sha256" text NOT NULL,
	"source_url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legal_text_kind_sha256_unique" UNIQUE("kind","sha256"),
	CONSTRAINT "legal_text_kind_check" CHECK ("legal_text"."kind" in ('terms', 'sla', 'dpa'))
);
--> statement-breakpoint
CREATE TABLE "legal_text_source" (
	"kind" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"checked_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "billing_account" ADD COLUMN "kvk_number" varchar(255);--> statement-breakpoint
ALTER TABLE "billing_account" ADD COLUMN "kbo_number" varchar(255);--> statement-breakpoint
ALTER TABLE "billing_account" ADD COLUMN "billing_email" varchar(255);--> statement-breakpoint
ALTER TABLE "billing_account" ADD COLUMN "po_number" varchar(255);--> statement-breakpoint
ALTER TABLE "billing_account" ADD COLUMN "peppol_id" varchar(255);--> statement-breakpoint
ALTER TABLE "org" ADD COLUMN "account_stage" varchar(32);--> statement-breakpoint
ALTER TABLE "org" ADD COLUMN "origin_pricing_configuration_id" uuid;--> statement-breakpoint
ALTER TABLE "account_document" ADD CONSTRAINT "account_document_org_id_foreign" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_document" ADD CONSTRAINT "account_document_supersedes_id_foreign" FOREIGN KEY ("supersedes_id") REFERENCES "public"."account_document"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_document" ADD CONSTRAINT "account_document_terms_text_id_foreign" FOREIGN KEY ("terms_text_id") REFERENCES "public"."legal_text"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_document" ADD CONSTRAINT "account_document_sla_text_id_foreign" FOREIGN KEY ("sla_text_id") REFERENCES "public"."legal_text"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_document" ADD CONSTRAINT "account_document_dpa_text_id_foreign" FOREIGN KEY ("dpa_text_id") REFERENCES "public"."legal_text"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_document_field" ADD CONSTRAINT "account_document_field_document_id_foreign" FOREIGN KEY ("document_id") REFERENCES "public"."account_document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_event" ADD CONSTRAINT "account_event_org_id_foreign" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_signature" ADD CONSTRAINT "account_signature_document_id_foreign" FOREIGN KEY ("document_id") REFERENCES "public"."account_document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_task" ADD CONSTRAINT "account_task_org_id_foreign" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_task" ADD CONSTRAINT "account_task_document_id_foreign" FOREIGN KEY ("document_id") REFERENCES "public"."account_document"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_task" ADD CONSTRAINT "account_task_unlock_on_document_id_foreign" FOREIGN KEY ("unlock_on_document_id") REFERENCES "public"."account_document"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_ticket" ADD CONSTRAINT "account_ticket_org_id_foreign" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_ticket_message" ADD CONSTRAINT "account_ticket_message_ticket_id_foreign" FOREIGN KEY ("ticket_id") REFERENCES "public"."account_ticket"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_document_org_id_index" ON "account_document" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "account_document_signer_email_index" ON "account_document" USING btree ("signer_email");--> statement-breakpoint
CREATE INDEX "account_document_field_document_id_index" ON "account_document_field" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "account_event_org_id_created_at_index" ON "account_event" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "account_signature_org_id_index" ON "account_signature" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "account_task_org_id_index" ON "account_task" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "account_task_next_reminder_at_index" ON "account_task" USING btree ("next_reminder_at");--> statement-breakpoint
CREATE INDEX "account_ticket_org_id_index" ON "account_ticket" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "account_ticket_message_ticket_id_index" ON "account_ticket_message" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "legal_text_kind_created_at_index" ON "legal_text" USING btree ("kind","created_at");--> statement-breakpoint
ALTER TABLE "org" ADD CONSTRAINT "org_origin_pricing_configuration_id_foreign" FOREIGN KEY ("origin_pricing_configuration_id") REFERENCES "public"."pricing_configuration"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org" ADD CONSTRAINT "org_account_stage_check" CHECK ("org"."account_stage" is null or "org"."account_stage" in ('prospect', 'customer', 'churned'));--> statement-breakpoint
-- Evidence is never changed or removed, whoever asks: a signature, and a legal text an
-- offer may have pinned. Enforced here rather than by grants so it holds for the owner too.
CREATE FUNCTION "account_refuse_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION '% is insert-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE TRIGGER "account_signature_insert_only" BEFORE UPDATE OR DELETE ON "account_signature"
	FOR EACH ROW EXECUTE FUNCTION "account_refuse_change"();
--> statement-breakpoint
CREATE TRIGGER "account_signature_no_truncate" BEFORE TRUNCATE ON "account_signature"
	FOR EACH STATEMENT EXECUTE FUNCTION "account_refuse_change"();
--> statement-breakpoint
CREATE TRIGGER "legal_text_insert_only" BEFORE UPDATE OR DELETE ON "legal_text"
	FOR EACH ROW EXECUTE FUNCTION "account_refuse_change"();
--> statement-breakpoint
CREATE TRIGGER "legal_text_no_truncate" BEFORE TRUNCATE ON "legal_text"
	FOR EACH STATEMENT EXECUTE FUNCTION "account_refuse_change"();
--> statement-breakpoint
-- A sent document is what the customer reads and signs: its text, hash, lines, totals and
-- pinned legal texts cannot change afterwards, and a signed one stays signed. A change is
-- a new document that supersedes it. Invoice payment fields stay writable for sam.
CREATE FUNCTION "account_document_freeze_sent"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF OLD.status <> 'draft' AND (
		NEW.body IS DISTINCT FROM OLD.body OR
		NEW.sha256 IS DISTINCT FROM OLD.sha256 OR
		NEW.page_count IS DISTINCT FROM OLD.page_count OR
		(NEW.file_key IS DISTINCT FROM OLD.file_key AND OLD.kind <> 'invoice') OR
		NEW.version IS DISTINCT FROM OLD.version OR
		NEW.content::text IS DISTINCT FROM OLD.content::text OR
		NEW.lines::text IS DISTINCT FROM OLD.lines::text OR
		NEW.total_cents IS DISTINCT FROM OLD.total_cents OR
		NEW.terms_text_id IS DISTINCT FROM OLD.terms_text_id OR
		NEW.sla_text_id IS DISTINCT FROM OLD.sla_text_id OR
		NEW.dpa_text_id IS DISTINCT FROM OLD.dpa_text_id
	) THEN
		RAISE EXCEPTION 'account_document % is sent and cannot change', OLD.id
			USING ERRCODE = 'insufficient_privilege';
	END IF;
	IF OLD.status = 'signed' AND NEW.status <> 'signed' THEN
		RAISE EXCEPTION 'account_document % is signed', OLD.id USING ERRCODE = 'insufficient_privilege';
	END IF;
	RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "account_document_frozen_when_sent" BEFORE UPDATE ON "account_document"
	FOR EACH ROW EXECUTE FUNCTION "account_document_freeze_sent"();
--> statement-breakpoint
-- The fields of a sent document are the ones the signer was shown: placed while it is a
-- draft, fixed once it is sent.
CREATE FUNCTION "account_document_field_freeze"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	doc_status text;
BEGIN
	SELECT status INTO doc_status FROM "account_document"
		WHERE id = COALESCE(NEW.document_id, OLD.document_id);
	IF doc_status IS NOT NULL AND doc_status <> 'draft' THEN
		RAISE EXCEPTION 'fields of a sent document cannot change' USING ERRCODE = 'insufficient_privilege';
	END IF;
	RETURN COALESCE(NEW, OLD);
END
$$;
--> statement-breakpoint
CREATE TRIGGER "account_document_field_frozen_when_sent" BEFORE INSERT OR UPDATE OR DELETE
	ON "account_document_field" FOR EACH ROW EXECUTE FUNCTION "account_document_field_freeze"();
