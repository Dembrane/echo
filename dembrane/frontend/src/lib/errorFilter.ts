import type { CaptureResult } from "posthog-js";

// Browser and extension noise that says nothing about our code. Each row is
// one known source: add a row to silence another. Matching is on the
// exception message; `needsNoStack` limits a row to errors that carry no
// stack frames, so a real error that happens to share the text is kept.
type NoiseRule = {
	reason: string;
	pattern: RegExp;
	needsNoStack?: boolean;
};

export const NOISE_RULES: NoiseRule[] = [
	{
		// Cross-origin script errors: the browser hides message, file and stack.
		needsNoStack: true,
		pattern: /^Script error\.?$/i,
		reason: "cross-origin script error without details",
	},
	{
		pattern: /window\.ethereum|\bselectedAddress\b/,
		reason: "crypto wallet extension injecting into the page",
	},
	{
		pattern: /__firefox__/,
		reason: "Firefox iOS in-page helper missing",
	},
	{
		pattern: /ResizeObserver loop/i,
		reason: "harmless layout notification from the browser",
	},
	{
		pattern: /Object Not Found Matching Id/i,
		reason: "Outlook link scanner opening the page",
	},
];

// A runaway loop sends the same exception thousands of times. Past this many
// per page session, repeats of one message are dropped.
export const MAX_REPEATS_PER_MESSAGE = 5;

type ExceptionEntry = {
	type?: string;
	value?: string;
	stacktrace?: { frames?: unknown[] };
};

function exceptionEntries(properties: Record<string, unknown>) {
	const list = properties.$exception_list;
	return Array.isArray(list) ? (list as ExceptionEntry[]) : [];
}

function messagesOf(properties: Record<string, unknown>): string[] {
	const fromList = exceptionEntries(properties)
		.map((entry) => entry.value)
		.filter((value): value is string => typeof value === "string");
	if (fromList.length > 0) return fromList;
	const legacy = properties.$exception_message;
	return typeof legacy === "string" ? [legacy] : [];
}

function hasStack(properties: Record<string, unknown>): boolean {
	return exceptionEntries(properties).some(
		(entry) => (entry.stacktrace?.frames?.length ?? 0) > 0,
	);
}

export function isKnownNoise(properties: Record<string, unknown>): boolean {
	const messages = messagesOf(properties).map((m) => m.trim());
	const stacked = hasStack(properties);
	return NOISE_RULES.some(
		(rule) =>
			!(rule.needsNoStack && stacked) &&
			messages.some((message) => rule.pattern.test(message)),
	);
}

// Only `$exception` events are touched; every other event passes unchanged.
export function createErrorFilter(maxRepeats = MAX_REPEATS_PER_MESSAGE) {
	const seen = new Map<string, number>();

	return (event: CaptureResult | null): CaptureResult | null => {
		if (!event || event.event !== "$exception") return event;
		const properties = (event.properties ?? {}) as Record<string, unknown>;

		if (isKnownNoise(properties)) return null;

		const key = messagesOf(properties).join("|");
		if (key) {
			const count = (seen.get(key) ?? 0) + 1;
			seen.set(key, count);
			if (count > maxRepeats) return null;
		}
		return event;
	};
}

// One instance per page load, so the cap is per page session.
export const errorFilter = createErrorFilter();
