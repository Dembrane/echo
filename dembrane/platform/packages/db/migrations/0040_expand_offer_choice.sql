-- An offer with options is signed with the customer's choice: at the moment it becomes signed,
-- its lines and totals change once to count the options they chose. What was sent (content,
-- body, PDF and its hash) still never changes. Everything else as in 0039. Safe to run twice.
CREATE OR REPLACE FUNCTION "account_document_freeze_sent"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF OLD.status <> 'draft' AND (
		NEW.body IS DISTINCT FROM OLD.body OR
		NEW.sha256 IS DISTINCT FROM OLD.sha256 OR
		NEW.page_count IS DISTINCT FROM OLD.page_count OR
		(NEW.file_key IS DISTINCT FROM OLD.file_key AND OLD.kind <> 'invoice') OR
		NEW.version IS DISTINCT FROM OLD.version OR
		NEW.content::text IS DISTINCT FROM OLD.content::text OR
		NEW.terms_text_id IS DISTINCT FROM OLD.terms_text_id OR
		NEW.sla_text_id IS DISTINCT FROM OLD.sla_text_id OR
		NEW.dpa_text_id IS DISTINCT FROM OLD.dpa_text_id
	) THEN
		RAISE EXCEPTION 'account_document % is sent and cannot change', OLD.id
			USING ERRCODE = 'insufficient_privilege';
	END IF;
	IF OLD.status <> 'draft' AND (
		NEW.lines::text IS DISTINCT FROM OLD.lines::text OR
		NEW.subtotal_cents IS DISTINCT FROM OLD.subtotal_cents OR
		NEW.vat_cents IS DISTINCT FROM OLD.vat_cents OR
		NEW.total_cents IS DISTINCT FROM OLD.total_cents
	) AND NOT (
		OLD.status IN ('sent', 'viewed') AND NEW.status = 'signed' AND (OLD.content->>'choose') IS NOT NULL
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
