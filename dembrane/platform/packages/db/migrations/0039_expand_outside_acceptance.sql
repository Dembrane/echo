-- An offer or DPA the customer accepted outside dembrane (their order letter, an email, a
-- signature on paper or on their own DPA) is recorded by staff as a signature row with
-- method 'outside': who accepted, the day, the evidence file and its hash. Such a row has no
-- signer account and no signature image. Safe to run twice.
ALTER TABLE "account_signature" DROP CONSTRAINT IF EXISTS "account_signature_method_check";--> statement-breakpoint
ALTER TABLE "account_signature" DROP CONSTRAINT IF EXISTS "account_signature_outside_check";--> statement-breakpoint
ALTER TABLE "account_signature" DROP CONSTRAINT IF EXISTS "account_signature_image_check";--> statement-breakpoint
ALTER TABLE "account_signature" ALTER COLUMN "signer_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "account_signature" ALTER COLUMN "image_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "account_signature" ALTER COLUMN "image_sha256" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "account_signature" ADD COLUMN IF NOT EXISTS "outside_via" text;--> statement-breakpoint
ALTER TABLE "account_signature" ADD COLUMN IF NOT EXISTS "accepted_on" date;--> statement-breakpoint
ALTER TABLE "account_signature" ADD COLUMN IF NOT EXISTS "evidence_key" text;--> statement-breakpoint
ALTER TABLE "account_signature" ADD COLUMN IF NOT EXISTS "evidence_sha256" text;--> statement-breakpoint
ALTER TABLE "account_signature" ADD COLUMN IF NOT EXISTS "evidence_name" text;--> statement-breakpoint
ALTER TABLE "account_signature" ADD COLUMN IF NOT EXISTS "evidence_type" text;--> statement-breakpoint
ALTER TABLE "account_signature" ADD COLUMN IF NOT EXISTS "customer_reference" text;--> statement-breakpoint
ALTER TABLE "account_signature" ADD COLUMN IF NOT EXISTS "recorded_by" uuid;--> statement-breakpoint
ALTER TABLE "account_signature" ADD CONSTRAINT "account_signature_outside_check" CHECK (("account_signature"."method" = 'outside') = ("account_signature"."outside_via" is not null) and ("account_signature"."outside_via" is null or ("account_signature"."outside_via" in ('order_letter', 'email', 'paper', 'own_document') and "account_signature"."accepted_on" is not null and "account_signature"."evidence_key" is not null and "account_signature"."evidence_sha256" is not null)));--> statement-breakpoint
ALTER TABLE "account_signature" ADD CONSTRAINT "account_signature_image_check" CHECK ("account_signature"."method" = 'outside' or ("account_signature"."signer_user_id" is not null and "account_signature"."image_key" is not null and "account_signature"."image_sha256" is not null));--> statement-breakpoint
ALTER TABLE "account_signature" ADD CONSTRAINT "account_signature_method_check" CHECK ("account_signature"."method" in ('drawn', 'typed', 'uploaded', 'outside'));--> statement-breakpoint
-- A signed document stays signed, except one accepted outside dembrane: staff may void that
-- with a reason (a wrong letter, the wrong offer), and its acceptance row stays as the record.
-- Everything else as in 0008: what was sent never changes.
CREATE OR REPLACE FUNCTION "account_document_freeze_sent"() RETURNS trigger LANGUAGE plpgsql AS $$
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
	IF OLD.status = 'signed' AND NEW.status <> 'signed' AND NOT (
		NEW.status = 'void' AND EXISTS (
			SELECT 1 FROM "account_signature" s
			WHERE s.document_id = OLD.id AND s.method = 'outside'
		)
	) THEN
		RAISE EXCEPTION 'account_document % is signed', OLD.id USING ERRCODE = 'insufficient_privilege';
	END IF;
	RETURN NEW;
END
$$;
