import {
	ANSWER_KEYS,
	CONFIG_SHAPE_VERSION,
	QUESTION_SET_VERSION,
	type QuestionKey,
} from "./questions";

/** The answers, the `config` object and the session storage record.
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

/** The `config` property: the shaped object that rides on every event.
 *
 * A missing key means the question was not answered. Nothing is required, so
 * absence is the most common state and it must be cheap. Never send null to
 * mean "skipped" and never send an empty array.
 *
 * No free text ever leaves in an event. Lengths only. The text lives on the
 * durable row, which is where it is read.
 */
export type PricingConfig = {
	v: number;
	set: string;
	use_case?: string[];
	use_case_other_chars?: number;
	volume?: string;
	concurrency?: string;
	concurrency_exact?: number;
	timing_chars?: number;
	timing_example?: string | null;
	extras?: string[];
	context_chars?: number;
	answered: number;
	furthest_step: number;
};

const hasText = (value: string | undefined): value is string =>
	typeof value === "string" && value.trim().length > 0;

const hasList = (value: string[] | undefined): value is string[] =>
	Array.isArray(value) && value.length > 0;

/** True when this question holds something worth recording. */
export const isAnswered = (answers: Answers, key: QuestionKey): boolean => {
	switch (key) {
		case "use_case":
			return hasList(answers.use_case);
		case "volume":
			return hasText(answers.volume);
		case "concurrency":
			return hasText(answers.concurrency);
		case "timing":
			return hasText(answers.timing);
		case "extras":
			return hasList(answers.extras);
		case "context":
			return hasText(answers.context);
		default:
			return false;
	}
};

/** How many of the six carry an answer.
 *
 * Six, not five: `context` shares the last step with `extras` rather than
 * having a step of its own, and it is still an answer.
 */
export const answeredCount = (answers: Answers): number =>
	ANSWER_KEYS.filter((key) => isAnswered(answers, key)).length;

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

/** True when the number box is on screen and holds something unreadable.
 *
 * Empty is not invalid: nothing is required. Only a filled box that is not a
 * number is, for example "forty-ish".
 */
export const hasUnreadableExactCount = (answers: Answers): boolean =>
	answers.concurrency === "more_than_40" &&
	hasText(answers.concurrency_exact) &&
	parseExactCount(answers.concurrency_exact) === undefined;

/** Build the `config` object that rides on every event from `started` onward.
 *
 * The whole configuration, not a difference. An abandonment tells us nothing
 * unless we know what sat on the screen when the person left.
 */
export const buildConfig = (
	answers: Answers,
	furthestStep: number,
): PricingConfig => {
	const config: PricingConfig = {
		answered: answeredCount(answers),
		furthest_step: furthestStep,
		set: QUESTION_SET_VERSION,
		v: CONFIG_SHAPE_VERSION,
	};

	if (hasList(answers.use_case)) config.use_case = [...answers.use_case];
	if (hasText(answers.use_case_other)) {
		config.use_case_other_chars = answers.use_case_other.length;
	}
	if (hasText(answers.volume)) config.volume = answers.volume;
	if (hasText(answers.concurrency)) {
		config.concurrency = answers.concurrency;
		const exact = parseExactCount(answers.concurrency_exact);
		if (answers.concurrency === "more_than_40" && exact !== undefined) {
			config.concurrency_exact = exact;
		}
	}
	if (hasText(answers.timing)) {
		config.timing_chars = answers.timing.length;
		config.timing_example = answers.timing_example ?? null;
	}
	if (hasList(answers.extras)) config.extras = [...answers.extras];
	if (hasText(answers.context)) config.context_chars = answers.context.length;

	return config;
};

/** One key. It holds the record, and the record carries the session id, so a
 * reload finds the same attempt rather than starting a second one. */
export const CONFIG_STORAGE_KEY = "dembrane-pricing-configuration";

export type StoredConfiguration = {
	config_session_id: string;
	question_set_version: string;
	answers: Answers;
	furthest_step: number;
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

const storage = (): Storage | null => {
	try {
		return globalThis.sessionStorage ?? null;
	} catch {
		// Private modes and blocked storage throw on access, not on read.
		return null;
	}
};

/** What a reload brings back, or null when there is nothing to resume. */
export const readStoredConfiguration = (): StoredConfiguration | null => {
	const store = storage();
	if (!store) return null;
	try {
		const raw = store.getItem(CONFIG_STORAGE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<StoredConfiguration>;
		if (typeof parsed?.config_session_id !== "string") return null;
		return {
			answers: (parsed.answers ?? {}) as Answers,
			config_session_id: parsed.config_session_id,
			furthest_step:
				typeof parsed.furthest_step === "number" ? parsed.furthest_step : 1,
			question_set_version:
				typeof parsed.question_set_version === "string"
					? parsed.question_set_version
					: QUESTION_SET_VERSION,
		};
	} catch {
		return null;
	}
};

export const writeStoredConfiguration = (record: StoredConfiguration): void => {
	const store = storage();
	if (!store) return;
	try {
		store.setItem(CONFIG_STORAGE_KEY, JSON.stringify(record));
	} catch {
		// A full or blocked store must never stop the form. The row on the server
		// is the record; this is only what survives a reload.
	}
};

export const clearStoredConfiguration = (): void => {
	const store = storage();
	if (!store) return;
	try {
		store.removeItem(CONFIG_STORAGE_KEY);
	} catch {
		// Same reason as above.
	}
};
