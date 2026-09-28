import type { Codes } from "./types";

/** Documents in a customer account: offers, agreements, invoices, and signing them. */
export const document = {
  "document.not_found": {
    action: "none",
    detail: "Document not found",
    description:
      "The document does not exist, is still a draft, or belongs to another organisation.",
  },
  "document.signer_only": {
    action: "none",
    detail: "Only {signer_email} can sign this document",
    description: "The document names one signer and the caller is someone else.",
  },
  "document.decline_signer_only": {
    action: "none",
    detail: "Only {signer_email} can decline this document",
    description: "The document names one signer and someone else tried to decline it.",
  },
  "document.not_declinable": {
    action: "none",
    detail: "This document cannot be declined now",
    description: "Only a sent or viewed document that needs a signature can be declined.",
  },
  "document.not_awaiting_signature": {
    action: "none",
    detail: "This document is not waiting for a signature",
    description: "The signing page was opened for a document that is not sent or viewed.",
  },
  "document.no_pdf": {
    action: "none",
    detail: "This document has no PDF",
    description: "The document's PDF is missing from storage.",
  },
  "document.not_signed": {
    action: "none",
    detail: "This document is not signed",
    description: "The signed PDF was asked for before the document was signed.",
  },
  "document.verified_email_required": {
    action: "sign_in",
    detail: "Sign in with a verified email address to sign",
    description: "Signing needs a session with a verified email address.",
  },
  "document.no_signature_needed": {
    action: "none",
    detail: "This document does not need a signature",
    description: "A signature was sent for a document that asks for none.",
  },
  "document.already_signed": {
    action: "none",
    detail: "This document is already signed",
    description: "The document was signed before, possibly by a racing request.",
  },
  "document.declined": {
    action: "none",
    detail: "This document was declined",
    description: "The document was declined and can no longer be signed.",
  },
  "document.withdrawn": {
    action: "none",
    detail: "This document was withdrawn",
    description: "Staff voided the document; it can no longer be signed.",
  },
  "document.offer_expired": {
    action: "contact_support",
    detail: "This offer expired on {valid_until}; ask us for a new one",
    description: "The offer's valid-until date has passed.",
  },
  "document.changed": {
    action: "retry",
    detail: "The document changed since you opened it. Reload it and read it again before signing.",
    description: "The sha256 the signer's page presented no longer matches the document.",
  },
  "document.signing_unavailable": {
    action: "contact_support",
    detail: "This document cannot be signed right now; we have been told.",
    description: "The stored PDF is missing or no longer matches its sha256; an error is logged.",
  },
  "document.dpa_not_authorised": {
    action: "fix_input",
    detail: "Only someone authorised to agree to data processing signs this",
    description: "A DPA was signed without confirming the signer is authorised.",
  },
  "document.confirmation_mismatch": {
    action: "fix_input",
    detail: "The confirmation text does not match what this document asks: {expected}",
    description: "The confirmation sentence differs from the one the server builds.",
  },
  "document.signature_unreadable": {
    action: "fix_input",
    detail: "The signature image could not be read as a PNG",
    description: "pdf-lib could not decode the signature or initials PNG.",
  },
  "document.image_too_large": {
    action: "fix_input",
    detail: "The {what} image is larger than 512 KB",
    description: "The signature or initials image is over 512 KB. what is signature or initials.",
  },
  "document.image_not_png": {
    action: "fix_input",
    detail: "The {what} image must be a PNG",
    description: "The signature or initials image is not a PNG. what is signature or initials.",
  },
  "document.field_unknown": {
    action: "retry",
    detail: "Unknown field {key}",
    description: "A value was sent for a field the document does not have.",
  },
  "document.field_tick_invalid": {
    action: "fix_input",
    detail: "{label}: tick or untick",
    description: "A checkbox field got a value that is not true or false.",
  },
  "document.field_must_tick": {
    action: "fix_input",
    detail: "{label} must be ticked",
    description: "A required checkbox field is not ticked.",
  },
  "document.field_text_invalid": {
    action: "fix_input",
    detail: "{label}: expected text",
    description: "A text field got a value that is not text.",
  },
  "document.field_required": {
    action: "fix_input",
    detail: "{label} is required",
    description: "A required text field is empty.",
  },
  "document.pdf_invalid": {
    action: "fix_input",
    detail: "pdf_base64 is not a PDF",
    audience: "staff",
    description: "The uploaded base64 does not start with a PDF header.",
  },
  "document.pdf_unreadable": {
    action: "fix_input",
    detail: "pdf_base64 is not a readable PDF",
    audience: "staff",
    description: "The uploaded PDF could not be parsed to count its pages.",
  },
  "document.supersede_not_found": {
    action: "none",
    detail: "Document to supersede not found",
    audience: "staff",
    description: "The document a new one replaces does not exist or is of another kind.",
  },
  "document.signed_cannot_supersede": {
    action: "none",
    detail: "A signed document cannot be superseded",
    audience: "staff",
    description: "Signed documents are final; a replacement is a new document.",
  },
  "document.title_required": {
    action: "fix_input",
    detail: "A document needs a title",
    audience: "staff",
    description: "A document was created without a title.",
  },
  "document.content_required": {
    action: "fix_input",
    detail: "A document needs a body or a PDF",
    audience: "staff",
    description: "A document was created with neither a body nor a PDF.",
  },
  "document.fields_invalid": {
    action: "fix_input",
    detail: "{problem}",
    audience: "staff",
    description:
      "The placed signing fields do not fit the document (off the page, or no signature or name field).",
  },
  "document.fields_fixed": {
    action: "none",
    detail: "Fields are fixed once a document is sent",
    audience: "staff",
    description: "Fields can only be placed on a draft.",
  },
  "document.already_sent": {
    action: "none",
    detail: "This document was already sent",
    audience: "staff",
    description: "Send was asked for a document that is no longer a draft.",
  },
  "document.signed_cannot_void": {
    action: "none",
    detail: "A signed document cannot be voided",
    audience: "staff",
    description: "Signed documents are final and cannot be withdrawn.",
  },
} as const satisfies Codes<"document">;
