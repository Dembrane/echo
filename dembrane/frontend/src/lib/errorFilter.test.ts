import type { CaptureResult } from "posthog-js";
import { describe, expect, it } from "vitest";
import {
	createErrorFilter,
	MAX_REPEATS_PER_MESSAGE,
	NOISE_RULES,
} from "./errorFilter";

const frame = {
	filename: "https://portal.dembrane.com/assets/index.js",
	function: "r",
	lineno: 1,
	platform: "web:javascript",
};

function exception(
	value: string,
	opts: { type?: string; withStack?: boolean } = {},
): CaptureResult {
	return {
		event: "$exception",
		properties: {
			$exception_level: "error",
			$exception_list: [
				{
					mechanism: { handled: false, synthetic: false, type: "generic" },
					type: opts.type ?? "Error",
					value,
					...(opts.withStack
						? { stacktrace: { frames: [frame], type: "raw" } }
						: {}),
				},
			],
		},
		uuid: "019a0000-0000-7000-8000-000000000000",
	};
}

describe("errorFilter", () => {
	it.each([
		["Script error.", undefined],
		[
			"Cannot read properties of undefined (reading 'selectedAddress')",
			undefined,
		],
		["window.ethereum.selectedAddress is undefined", undefined],
		["Can't find variable: __firefox__", undefined],
		["window.__firefox__.reader is not an object", undefined],
		["window.__firefox__.searchQueryForField is not a function", undefined],
		[
			"ResizeObserver loop completed with undelivered notifications.",
			undefined,
		],
		["ResizeObserver loop limit exceeded", undefined],
		[
			"Object Not Found Matching Id:3, MethodName:update, ParamCount:4",
			undefined,
		],
	])("drops known noise: %s", (message) => {
		const filter = createErrorFilter();
		expect(filter(exception(message))).toBeNull();
	});

	it("keeps a Script error that carries a stack", () => {
		const filter = createErrorFilter();
		const event = exception("Script error.", { withStack: true });
		expect(filter(event)).toBe(event);
	});

	it("keeps real errors, including failed requests", () => {
		const filter = createErrorFilter();
		for (const message of [
			"Recording interrupted by consecutive suspicious chunks",
			"Failed to fetch",
			"Load failed",
		]) {
			const event = exception(message, { withStack: true });
			expect(filter(event)).toBe(event);
		}
	});

	it("reads the legacy $exception_message property", () => {
		const filter = createErrorFilter();
		const event: CaptureResult = {
			event: "$exception",
			properties: { $exception_message: "ResizeObserver loop limit exceeded" },
			uuid: "x",
		};
		expect(filter(event)).toBeNull();
	});

	it("caps repeats of the same message per page session", () => {
		const filter = createErrorFilter();
		const results = Array.from({ length: MAX_REPEATS_PER_MESSAGE + 3 }, () =>
			filter(exception("Something broke", { withStack: true })),
		);
		expect(results.filter(Boolean)).toHaveLength(MAX_REPEATS_PER_MESSAGE);
		// A different message is counted separately.
		expect(
			filter(exception("Another thing", { withStack: true })),
		).not.toBeNull();
	});

	it("lets every other event through untouched", () => {
		const filter = createErrorFilter(1);
		const pageview: CaptureResult = {
			event: "$pageview",
			properties: { $exception_list: [{ value: "Script error." }] },
			uuid: "y",
		};
		for (let i = 0; i < 5; i++) expect(filter(pageview)).toBe(pageview);
		expect(filter(null)).toBeNull();
	});

	it("documents every rule", () => {
		for (const rule of NOISE_RULES)
			expect(rule.reason.length).toBeGreaterThan(0);
	});
});
