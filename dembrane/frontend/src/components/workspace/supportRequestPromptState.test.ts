// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	markRequestSeen,
	openSupportRequest,
	requestSeen,
	resetSupportRequestSeen,
	SUPPORT_REQUEST_SEEN_KEY,
	useSupportRequestPromptState,
} from "./supportRequestPromptState";

beforeEach(() => {
	sessionStorage.clear();
	resetSupportRequestSeen();
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("which requests were closed this browser session", () => {
	it("a closed request is remembered, others are not", () => {
		expect(requestSeen("r-1")).toBe(false);
		markRequestSeen("r-1");
		expect(requestSeen("r-1")).toBe(true);
		expect(requestSeen("r-2")).toBe(false);
	});

	it("remembers several requests", () => {
		markRequestSeen("r-1");
		markRequestSeen("r-2");
		expect(requestSeen("r-1")).toBe(true);
		expect(requestSeen("r-2")).toBe(true);
	});

	it("keeps it in session storage, so a reload in the same session still knows", async () => {
		markRequestSeen("r-1");
		expect(sessionStorage.getItem(SUPPORT_REQUEST_SEEN_KEY)).toContain("r-1");
		// A reload: the module starts again and reads what the session stored.
		vi.resetModules();
		const fresh = await import("./supportRequestPromptState");
		expect(fresh.requestSeen("r-1")).toBe(true);
		expect(fresh.requestSeen("r-2")).toBe(false);
	});

	it("a new browser session starts with nothing remembered", async () => {
		markRequestSeen("r-1");
		sessionStorage.clear();
		vi.resetModules();
		const fresh = await import("./supportRequestPromptState");
		expect(fresh.requestSeen("r-1")).toBe(false);
	});

	it("signing in forgets every closed request", () => {
		markRequestSeen("r-1");
		markRequestSeen("r-2");
		resetSupportRequestSeen();
		expect(requestSeen("r-1")).toBe(false);
		expect(requestSeen("r-2")).toBe(false);
		expect(sessionStorage.getItem(SUPPORT_REQUEST_SEEN_KEY)).toBeNull();
	});

	it("does not break when session storage refuses to be read or written", () => {
		const refuse = () => {
			throw new DOMException("blocked", "SecurityError");
		};
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(refuse);
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(refuse);
		vi.spyOn(Storage.prototype, "removeItem").mockImplementation(refuse);
		expect(() => requestSeen("r-1")).not.toThrow();
		expect(() => markRequestSeen("r-1")).not.toThrow();
		expect(() => resetSupportRequestSeen()).not.toThrow();
		expect(typeof requestSeen("r-1")).toBe("boolean");
	});
});

describe("useSupportRequestPromptState", () => {
	it("follows what was closed", () => {
		const { result } = renderHook(() => useSupportRequestPromptState());
		expect(result.current.seen).not.toContain("r-1");
		act(() => markRequestSeen("r-1"));
		expect(result.current.seen).toContain("r-1");
		act(() => resetSupportRequestSeen());
		expect(result.current.seen).not.toContain("r-1");
	});

	it("opening a request from the inbox names it as the one asked for", () => {
		const { result } = renderHook(() => useSupportRequestPromptState());
		act(() => openSupportRequest("r-asked"));
		expect(result.current.asked).toBe("r-asked");
		act(() => openSupportRequest("r-other"));
		expect(result.current.asked).toBe("r-other");
	});

	it("asking for a request that was closed this session asks for it all the same", () => {
		markRequestSeen("r-closed");
		const { result } = renderHook(() => useSupportRequestPromptState());
		act(() => openSupportRequest("r-closed"));
		expect(result.current.asked).toBe("r-closed");
	});
});
