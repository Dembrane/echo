// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useServerEvents } from "./useServerEvents";

class FakeEventSource {
	static instances: FakeEventSource[] = [];
	listeners = new Map<string, (message: MessageEvent) => void>();
	onerror: (() => void) | null = null;
	closed = false;
	constructor(public url: string) {
		FakeEventSource.instances.push(this);
	}
	addEventListener(name: string, listener: (message: MessageEvent) => void) {
		this.listeners.set(name, listener);
	}
	close() {
		this.closed = true;
	}
}

beforeEach(() => {
	FakeEventSource.instances = [];
	vi.stubGlobal("EventSource", FakeEventSource);
	vi.useFakeTimers();
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("useServerEvents", () => {
	it("tells a caller that asked about each drop, then reconnects", () => {
		const onEvent = vi.fn();
		renderHook(() =>
			useServerEvents("/events", ["update", "disconnected"], onEvent),
		);
		const first = FakeEventSource.instances[0];
		// `disconnected` is the hook's own signal, never a server event name.
		expect([...first.listeners.keys()].sort()).toEqual(["connected", "update"]);

		first.onerror?.();
		expect(onEvent).toHaveBeenCalledWith({ type: "disconnected" });
		expect(first.closed).toBe(true);

		vi.advanceTimersByTime(1000);
		expect(FakeEventSource.instances).toHaveLength(2);
	});

	it("stays quiet about drops for callers that did not ask", () => {
		const onEvent = vi.fn();
		renderHook(() => useServerEvents("/events", ["update"], onEvent));
		FakeEventSource.instances[0].onerror?.();
		expect(onEvent).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1000);
		expect(FakeEventSource.instances).toHaveLength(2);
	});
});
