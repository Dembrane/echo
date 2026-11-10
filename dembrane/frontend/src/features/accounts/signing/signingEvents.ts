import posthog from "posthog-js";

/**
 * The signing screen's product events, in one place so they move to the typed events
 * module in one go. Each carries the document's id and kind and nothing the signer typed:
 * no field values, names, email addresses or signature.
 *
 * Reading them: `document_signing_abandoned` is sent at most once per page life and never
 * after `document_signed`. A reload resumes the walk, so a reload reads as
 * `document_signing_abandoned` followed by `document_signing_resumed` for the same
 * document in the same session; only an abandoned event with no resumed after it is a
 * signer who left.
 */
export const SIGNING_EVENTS = {
	abandoned: "document_signing_abandoned",
	promptDismissed: "sign_prompt_dismissed",
	/** A stored draft was put back on load, with the step it resumed at. */
	resumed: "document_signing_resumed",
	signed: "document_signed",
	started: "document_signing_started",
	stepViewed: "document_signing_step_viewed",
} as const;

export type SigningEvent = (typeof SIGNING_EVENTS)[keyof typeof SIGNING_EVENTS];

export interface SigningDocumentRef {
	readonly id: string | null;
	readonly kind: string | null;
}

type Extra = {
	readonly step_index?: number;
	readonly step_kind?: string;
};

/** Sends one event; analytics never gets in the way of signing. */
export function captureSigning(
	event: SigningEvent,
	doc: SigningDocumentRef,
	extra: Extra = {},
): void {
	try {
		posthog.capture(event, {
			document_id: doc.id,
			document_kind: doc.kind,
			...extra,
		});
	} catch {}
}
