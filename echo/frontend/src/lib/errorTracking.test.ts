// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://portal.dembrane.com/nl-NL/abc123/start" }

import type { CaptureResult } from "posthog-js";
import { expect, it } from "vitest";
import { dropInjectedScriptExceptions } from "./errorTracking";

const PAGE_URL = "https://portal.dembrane.com/nl-NL/abc123/start";

const exceptionEvent = (frames: Array<{ filename?: string }>): CaptureResult =>
	({
		event: "$exception",
		properties: {
			$exception_list: [{ stacktrace: { frames } }],
		},
	}) as unknown as CaptureResult;

it("drops an exception whose only frame is the document URL", () => {
	const event = exceptionEvent([{ filename: PAGE_URL }]);
	expect(dropInjectedScriptExceptions(event)).toBeNull();
});

it("keeps an exception with a frame that points at a script asset", () => {
	const event = exceptionEvent([
		{ filename: "https://portal.dembrane.com/assets/index-a1b2c3.js" },
	]);
	expect(dropInjectedScriptExceptions(event)).toBe(event);
});

it("keeps an exception that mixes a document frame with an asset frame", () => {
	const event = exceptionEvent([
		{ filename: PAGE_URL },
		{ filename: "https://portal.dembrane.com/assets/index-a1b2c3.js" },
	]);
	expect(dropInjectedScriptExceptions(event)).toBe(event);
});

it("keeps an exception that has no stack frames", () => {
	const event = exceptionEvent([]);
	expect(dropInjectedScriptExceptions(event)).toBe(event);
});

it("ignores non-exception events", () => {
	const event = { event: "$pageview", properties: {} } as CaptureResult;
	expect(dropInjectedScriptExceptions(event)).toBe(event);
});

it("passes a null event through untouched", () => {
	expect(dropInjectedScriptExceptions(null)).toBeNull();
});
