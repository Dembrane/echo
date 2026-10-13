-- What the billing form asks since the country comes first. billing_country_code is the ISO
-- 3166-1 alpha-2 code of billing_country (which keeps the name). no_vat_number is true when the
-- customer said it has no VAT number, false when it was asked and gave one, null when not asked.
-- invoice_portal holds what the customer wrote about how they receive invoices when
-- invoice_delivery is "other" (neither email nor Peppol): often the name of an invoice portal.
-- All three are null on rows saved before this.
ALTER TABLE "billing_account" ADD COLUMN "billing_country_code" varchar(2);--> statement-breakpoint
ALTER TABLE "billing_account" ADD COLUMN "no_vat_number" boolean;--> statement-breakpoint
ALTER TABLE "billing_account" ADD COLUMN "invoice_portal" text;