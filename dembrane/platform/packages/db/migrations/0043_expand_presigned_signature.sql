-- dembrane signs what it sends: an offer and its DPA carry dembrane's signature from the
-- moment they are sent, as a signature row with method 'presigned' in the 'dembrane' slot.
-- Such a row has no signature image (the PDF prints it as signed electronically) and may
-- have no signer account. Safe to run twice.
ALTER TABLE "account_signature" DROP CONSTRAINT IF EXISTS "account_signature_method_check";--> statement-breakpoint
ALTER TABLE "account_signature" DROP CONSTRAINT IF EXISTS "account_signature_image_check";--> statement-breakpoint
ALTER TABLE "account_signature" ADD CONSTRAINT "account_signature_method_check" CHECK ("account_signature"."method" in ('drawn', 'typed', 'uploaded', 'outside', 'presigned'));--> statement-breakpoint
ALTER TABLE "account_signature" ADD CONSTRAINT "account_signature_image_check" CHECK ("account_signature"."method" = 'outside' or ("account_signature"."method" = 'presigned' and "account_signature"."slot" = 'dembrane') or ("account_signature"."signer_user_id" is not null and "account_signature"."image_key" is not null and "account_signature"."image_sha256" is not null));
