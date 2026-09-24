import type { CaptureResult } from "posthog-js";
import { describe, expect, it } from "vitest";
import { dropNetworkFaultExceptions } from "./networkFaults";

const event = (
	name: string,
	exceptions?: { type: string; value: string }[],
): CaptureResult =>
	({
		event: name,
		properties: exceptions ? { $exception_list: exceptions } : {},
		uuid: "test",
	}) as CaptureResult;

describe("dropNetworkFaultExceptions", () => {
	it("drops an Axios network error", () => {
		const e = event("$exception", [
			{ type: "AxiosError", value: "Network Error" },
		]);
		expect(dropNetworkFaultExceptions(e)).toBeNull();
	});

	it("drops an Axios network error with an upload prefix", () => {
		const e = event("$exception", [
			{
				type: "AxiosError",
				value:
					"Failed to get upload URL from server. Please try again. Original: Network Error",
			},
		]);
		expect(dropNetworkFaultExceptions(e)).toBeNull();
	});

	it("keeps other Axios errors", () => {
		const e = event("$exception", [
			{ type: "AxiosError", value: "Request failed with status code 500" },
		]);
		expect(dropNetworkFaultExceptions(e)).toBe(e);
	});

	it("keeps a plain Error with a network message", () => {
		const e = event("$exception", [{ type: "Error", value: "Network Error" }]);
		expect(dropNetworkFaultExceptions(e)).toBe(e);
	});

	it("keeps an exception chain that holds other errors", () => {
		const e = event("$exception", [
			{ type: "TypeError", value: "x is undefined" },
			{ type: "AxiosError", value: "Network Error" },
		]);
		expect(dropNetworkFaultExceptions(e)).toBe(e);
	});

	it("keeps events that are not exceptions", () => {
		const e = event("conversation_upload_failed");
		expect(dropNetworkFaultExceptions(e)).toBe(e);
	});
});
