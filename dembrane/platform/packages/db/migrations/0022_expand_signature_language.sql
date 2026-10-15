-- The language a document was signed in (en or nl), kept on the signature so the record says
-- which wording the signer saw. Null on signatures made before this.
ALTER TABLE "account_signature" ADD COLUMN "language" text;
