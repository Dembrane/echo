// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { apiNoAuth, PING_TIMEOUT_MS, pingConversation } from "@/lib/api";
import {
	FAILED_PINGS_BEFORE_TROUBLE,
	usePingConnectionHealth,
} from "./usePingConnectionHealth";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

it("a ping resolves to whether the API answered, and never throws", async () => {
	const post = vi.spyOn(apiNoAuth, "post").mockResolvedValueOnce({ ok: true });
	expect(await pingConversation("c1", { state: "recording" })).toBe(true);
	expect(post.mock.calls[0][0]).toBe("/participant/conversations/c1/ping");
	// A hung request must count as failed rather than wait forever.
	expect(post.mock.calls[0][2]).toEqual({ timeout: PING_TIMEOUT_MS });

	post.mockRejectedValueOnce(new Error("Network Error"));
	expect(await pingConversation("c1")).toBe(false);
});

it("the portal shows connection trouble after failed pings in a row, and clears it on one answer", async () => {
	const post = vi.spyOn(apiNoAuth, "post");
	const { result } = renderHook(() => usePingConnectionHealth());
	const ping = async () => {
		const answered = await pingConversation("c1");
		act(() => result.current.reportPing(answered));
	};

	post.mockResolvedValue({ ok: true });
	await ping();
	expect(result.current.connectionHealthy).toBe(true);

	// The API goes away. One lost ping is noise; a run of them is trouble.
	post.mockRejectedValue(new Error("Network Error"));
	await ping();
	expect(result.current.connectionHealthy).toBe(true);
	for (let i = 1; i < FAILED_PINGS_BEFORE_TROUBLE; i++) await ping();
	expect(result.current.connectionHealthy).toBe(false);

	// It comes back.
	post.mockResolvedValue({ ok: true });
	await ping();
	expect(result.current.connectionHealthy).toBe(true);
});

it("an answer in between resets the count", () => {
	const { result } = renderHook(() => usePingConnectionHealth());
	for (let i = 0; i < 5; i++) {
		act(() => result.current.reportPing(false));
		act(() => result.current.reportPing(true));
	}
	expect(result.current.connectionHealthy).toBe(true);
});
