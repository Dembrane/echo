import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const document = {
	"document.already_signed": msg({
		id: "error.document.already_signed",
		message: "This document is already signed. There is nothing more to do.",
	}),
	"document.changed": msg({
		id: "error.document.changed",
		message:
			"This document changed since you opened it. Reload the page and read it again before you sign.",
	}),
	"document.confirmation_mismatch": msg({
		id: "error.document.confirmation_mismatch",
		message:
			"The confirmation text does not match. Type it exactly as shown: {expected}",
	}),
	"document.decline_signer_only": msg({
		id: "error.document.decline_signer_only",
		message: "Only {signer_email} can decline this document.",
	}),
	"document.declined": msg({
		id: "error.document.declined",
		message: "This document was declined, so it can no longer be signed.",
	}),
	"document.dpa_not_authorised": msg({
		id: "error.document.dpa_not_authorised",
		message:
			"Confirm that you are authorised to agree to data processing for your organisation.",
	}),
	"document.field_must_tick": msg({
		id: "error.document.field_must_tick",
		message: "Tick {label} to continue.",
	}),
	"document.field_required": msg({
		id: "error.document.field_required",
		message: "Fill in {label} to continue.",
	}),
	"document.field_text_invalid": msg({
		id: "error.document.field_text_invalid",
		message: "Enter text for {label}.",
	}),
	"document.field_tick_invalid": msg({
		id: "error.document.field_tick_invalid",
		message: "Tick or untick {label}.",
	}),
	"document.field_unknown": msg({
		id: "error.document.field_unknown",
		message:
			"This document changed since you opened it. Reload the page and try again.",
	}),
	"document.image_not_png": msg({
		id: "error.document.image_not_png",
		message:
			"{what, select, initials {Your initials} other {Your signature}} must be a PNG image.",
	}),
	"document.image_too_large": msg({
		id: "error.document.image_too_large",
		message:
			"{what, select, initials {Your initials image} other {Your signature image}} is too large. Keep it under 512 KB.",
	}),
	"document.no_pdf": msg({
		id: "error.document.no_pdf",
		message:
			"The PDF of this document is not available. Contact us and we will send it again.",
	}),
	"document.no_signature_needed": msg({
		id: "error.document.no_signature_needed",
		message: "This document does not need a signature.",
	}),
	"document.not_awaiting_signature": msg({
		id: "error.document.not_awaiting_signature",
		message: "This document is not waiting for a signature anymore.",
	}),
	"document.not_declinable": msg({
		id: "error.document.not_declinable",
		message: "This document can no longer be declined.",
	}),
	"document.not_found": msg({
		id: "error.document.not_found",
		message: "We could not find this document. It may have been withdrawn.",
	}),
	"document.not_signed": msg({
		id: "error.document.not_signed",
		message:
			"This document is not signed yet, so there is no signed copy to download.",
	}),
	"document.offer_expired": msg({
		id: "error.document.offer_expired",
		message: "This offer expired on {valid_until}. Contact us for a new one.",
	}),
	"document.signature_unreadable": msg({
		id: "error.document.signature_unreadable",
		message:
			"We could not read your signature. Draw it again and try once more.",
	}),
	"document.signer_only": msg({
		id: "error.document.signer_only",
		message:
			"Only {signer_email} can sign this document. Ask them to sign it, or ask us to change the signer.",
	}),
	"document.signing_unavailable": msg({
		id: "error.document.signing_unavailable",
		message:
			"This document cannot be signed right now. We have been told and will fix it.",
	}),
	"document.verified_email_required": msg({
		id: "error.document.verified_email_required",
		message: "To sign, sign in with a verified email address.",
	}),
	"document.withdrawn": msg({
		id: "error.document.withdrawn",
		message: "This document was withdrawn, so it can no longer be signed.",
	}),
} satisfies Messages<"document">;
