/** The configurator's answer shape, still read by the booking step's prefill,
 * and the one id helper the upgrade prompt's handover uses.
 *
 * No React and no browser UI, so the parts that decide what leaves the page are
 * testable on their own.
 */

export type Answers = {
	use_case?: string[];
	/** The "Something else" box on the first question. Text stays on the row,
	 * never on an event. */
	use_case_other?: string;
	volume?: string;
	concurrency?: string;
	/** Kept as typed text so "forty-ish" can be shown back as unreadable rather
	 * than silently becoming nothing. */
	concurrency_exact?: string;
	timing?: string;
	/** Which example chip filled the box, null once the person types fresh. */
	timing_example?: string | null;
	extras?: string[];
	context?: string;
};

const hasText = (value: string | undefined): value is string =>
	typeof value === "string" && value.trim().length > 0;

/** The number a person typed into the "More than 40" box, or undefined when it
 * cannot be read. Undefined is what makes the one inline validation fire. */
export const parseExactCount = (
	raw: string | undefined,
): number | undefined => {
	if (!hasText(raw)) return undefined;
	const trimmed = raw.trim();
	if (!/^\d+$/.test(trimmed)) return undefined;
	const value = Number.parseInt(trimmed, 10);
	return Number.isFinite(value) ? value : undefined;
};

/** A fresh id for one attempt. `crypto.randomUUID` where it exists; the
 * fallback keeps an old browser working rather than losing the whole form to
 * a missing API. The fallback draws from
 * `getRandomValues`, never `Math.random`: the id travels to the server and
 * names a row, so CodeQL rightly treats it as a security context. */
export const newConfigSessionId = (): string => {
	const cryptoApi = globalThis.crypto;
	if (typeof cryptoApi?.randomUUID === "function")
		return cryptoApi.randomUUID();
	const bytes = new Uint8Array(16);
	cryptoApi.getRandomValues(bytes);
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
		"",
	);
	return `pc-${Date.now().toString(36)}-${hex}`;
};
