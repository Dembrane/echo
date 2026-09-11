// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationMonitor } from "./useConversationMonitor";

const captureMock = vi.hoisted(() => vi.fn());
vi.mock("posthog-js", () => ({ default: { capture: captureMock } }));

// Keep React Query idle so only the SSE path drives `isStreaming`.
vi.mock("@/lib/bff", () => ({
	bff: { get: () => new Promise(() => {}) },
}));

// A fake EventSource whose error/snapshot we drive by hand.
class FakeEventSource {
	static last: FakeEventSource | null = null;
	onerror: (() => void) | null = null;
	listeners = new Map<string, (event: Event) => void>();
	closed = false;
	constructor() {
		FakeEventSource.last = this;
	}
	addEventListener(type: string, cb: (event: Event) => void) {
		this.listeners.set(type, cb);
	}
	close() {
		this.closed = true;
	}
	emitSnapshot() {
		const event = new MessageEvent("snapshot", {
			data: JSON.stringify({
				conversations: [],
				live_window_seconds: 60,
				summary: {},
			}),
		});
		this.listeners.get("snapshot")?.(event);
	}
	emitError() {
		this.onerror?.();
	}
}

const latestSource = (): FakeEventSource => {
	if (!FakeEventSource.last) throw new Error("no EventSource opened");
	return FakeEventSource.last;
};

const wrapper = ({ children }: { children: ReactNode }) => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

describe("useConversationMonitor stream degradation", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		captureMock.mockClear();
		FakeEventSource.last = null;
		vi.stubGlobal("EventSource", FakeEventSource);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("ignores a brief flap that recovers inside the grace window", () => {
		const { result, unmount } = renderHook(
			() => useConversationMonitor("p-flap"),
			{ wrapper },
		);
		const source = latestSource();
		act(() => source.emitSnapshot());
		expect(result.current.isStreaming).toBe(true);

		// Drops, then recovers before the grace window elapses.
		act(() => source.emitError());
		act(() => {
			vi.advanceTimersByTime(4000);
		});
		expect(result.current.isStreaming).toBe(true);
		act(() => source.emitSnapshot());

		expect(captureMock).not.toHaveBeenCalled();
		act(() => unmount());
	});

	it("reports a sustained outage and its paired recovery", () => {
		const { result, unmount } = renderHook(
			() => useConversationMonitor("p-outage"),
			{ wrapper },
		);
		const source = latestSource();
		act(() => source.emitSnapshot());

		// Stays down past the grace window: now a real degradation.
		act(() => source.emitError());
		act(() => {
			vi.advanceTimersByTime(10000);
		});
		expect(result.current.isStreaming).toBe(false);
		expect(captureMock).toHaveBeenCalledWith("monitor_stream_degraded", {
			project_id: "p-outage",
		});

		act(() => source.emitSnapshot());
		expect(result.current.isStreaming).toBe(true);
		expect(captureMock).toHaveBeenCalledWith(
			"monitor_stream_reconnected",
			expect.objectContaining({ project_id: "p-outage" }),
		);
		act(() => unmount());
	});
});
