-- How Exact delivers a customer's invoices: invoice_delivery is "peppol" or "email", null until
-- someone chooses (then Peppol when peppol_id is known). peppol_name is the Peppol directory's
-- name for a peppol_id echo found there.
ALTER TABLE "billing_account" ADD COLUMN "peppol_name" varchar(255);--> statement-breakpoint
ALTER TABLE "billing_account" ADD COLUMN "invoice_delivery" varchar(16);