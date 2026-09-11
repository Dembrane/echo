// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capture = vi.fn();
const captureException = vi.fn();

vi.mock("posthog-js", () => ({
	default: {
		capture: (...args: unknown[]) => capture(...args),
		captureException: (...args: unknown[]) => captureException(...args),
	},
}));

import {
	captureRequestError,
	captureRequestErrorFromMeta,
	isNetworkError,
} from "./requestErrorCapture";

const setOnline = (online: boolean) => {
	Object.defineProperty(navigator, "onLine", {
		configurable: true,
		value: online,
	});
};

beforeEach(() => {
	capture.mockClear();
	captureException.mockClear();
	setOnline(true);
});

afterEach(() => {
	setOnline(true);
});

describe("isNetworkError", () => {
	it("treats a fetch TypeError as a network error", () => {
		expect(isNetworkError(new TypeError("Failed to fetch"))).toBe(true);
	});

	it("matches known network failure messages on a plain Error", () => {
		expect(isNetworkError(new Error("NetworkError when attempting"))).toBe(
			true,
		);
		expect(isNetworkError(new Error("Load failed"))).toBe(true);
	});

	it("treats an offline browser as a network error", () => {
		setOnline(false);
		expect(isNetworkError(new Error("anything"))).toBe(true);
	});

	it("does not flag an application error", () => {
		expect(isNetworkError(new Error("Request failed with status 500"))).toBe(
			false,
		);
	});
});

describe("captureRequestError", () => {
	it("records a network blip as a low-severity event, not an exception", () => {
		captureRequestError(
			new TypeError("Failed to fetch"),
			"announcement.latest",
		);

		expect(captureException).not.toHaveBeenCalled();
		expect(capture).toHaveBeenCalledWith("request_network_error", {
			offline: false,
			request: "announcement.latest",
		});
	});

	it("captures an application error as an exception tagged with the request", () => {
		const error = new Error("Request failed with status 500");
		captureRequestError(error, "announcement.summary");

		expect(capture).not.toHaveBeenCalled();
		expect(captureException).toHaveBeenCalledWith(error, {
			offline: false,
			request: "announcement.summary",
		});
	});

	it("marks the offline flag when the browser is offline", () => {
		setOnline(false);
		captureRequestError(
			new TypeError("Failed to fetch"),
			"announcement.latest",
		);

		expect(capture).toHaveBeenCalledWith("request_network_error", {
			offline: true,
			request: "announcement.latest",
		});
	});
});

describe("captureRequestErrorFromMeta", () => {
	it("captures only when meta carries a string errorName", () => {
		captureRequestErrorFromMeta(new Error("boom"), {
			errorName: "announcement.summary",
		});

		expect(captureException).toHaveBeenCalledTimes(1);
	});

	it("ignores errors from requests that did not opt in", () => {
		captureRequestErrorFromMeta(new Error("boom"), undefined);
		captureRequestErrorFromMeta(new Error("boom"), { other: "value" });

		expect(capture).not.toHaveBeenCalled();
		expect(captureException).not.toHaveBeenCalled();
	});
});
