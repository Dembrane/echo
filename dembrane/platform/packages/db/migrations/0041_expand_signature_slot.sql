-- A document may ask for more than one signature: the customer's, a second signatory of
-- theirs, and dembrane's counter-signature. Each is its own insert-only row, one per document
-- and slot; every existing row is the customer's. Safe to run twice.
ALTER TABLE "account_signature" ADD COLUMN IF NOT EXISTS "slot" text DEFAULT 'customer' NOT NULL;--> statement-breakpoint
ALTER TABLE "account_signature" DROP CONSTRAINT IF EXISTS "account_signature_slot_check";--> statement-breakpoint
ALTER TABLE "account_signature" ADD CONSTRAINT "account_signature_slot_check" CHECK ("account_signature"."slot" in ('customer', 'second', 'dembrane'));--> statement-breakpoint
ALTER TABLE "account_signature" DROP CONSTRAINT IF EXISTS "account_signature_document_slot_unique";--> statement-breakpoint
ALTER TABLE "account_signature" ADD CONSTRAINT "account_signature_document_slot_unique" UNIQUE("document_id","slot");--> statement-breakpoint
ALTER TABLE "account_signature" DROP CONSTRAINT IF EXISTS "account_signature_document_id_unique";
