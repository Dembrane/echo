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

// One tab or window holds the stream and passes each event on to the others.
class FakeChannel {
	static open: FakeChannel[] = [];
	onmessage: ((message: MessageEvent) => void) | null = null;
	constructor(public name: string) {
		FakeChannel.open.push(this);
	}
	postMessage(data: unknown) {
		for (const other of FakeChannel.open)
			if (other !== this && other.name === this.name)
				other.onmessage?.({ data } as MessageEvent);
	}
	close() {
		FakeChannel.open = FakeChannel.open.filter((c) => c !== this);
	}
}

// navigator.locks: one holder per name, the next waiter is granted on release.
function fakeLocks() {
	const held = new Set<string>();
	const waiting = new Map<string, (() => void)[]>();
	const grant = (name: string, run: () => Promise<unknown>) => {
		held.add(name);
		return run().finally(() => {
			held.delete(name);
			waiting.get(name)?.shift()?.();
		});
	};
	return {
		request(
			name: string,
			options: { signal?: AbortSignal },
			callback: () => Promise<unknown>,
		) {
			if (!held.has(name)) return grant(name, callback);
			return new Promise((resolve, reject) => {
				const queue = waiting.get(name) ?? [];
				const turn = () => grant(name, callback).then(resolve, reject);
				queue.push(turn);
				waiting.set(name, queue);
				options.signal?.addEventListener("abort", () => {
					waiting.set(
						name,
						(waiting.get(name) ?? []).filter((t) => t !== turn),
					);
					reject(new DOMException("Aborted", "AbortError"));
				});
			});
		},
	};
}

const emit = (source: FakeEventSource, name: string) =>
	source.listeners.get(name)?.({ data: "{}", type: name } as MessageEvent);

describe("useServerEvents shared between windows", () => {
	beforeEach(() => {
		FakeChannel.open = [];
		vi.stubGlobal("BroadcastChannel", FakeChannel);
		Object.defineProperty(navigator, "locks", {
			configurable: true,
			value: fakeLocks(),
		});
	});
	afterEach(() => {
		Reflect.deleteProperty(navigator, "locks");
	});

	it("opens one stream for two screens, and both hear every event", () => {
		const first = vi.fn();
		const second = vi.fn();
		renderHook(() =>
			useServerEvents("/events", ["update"], first, { shared: true }),
		);
		renderHook(() =>
			useServerEvents("/events", ["update"], second, { shared: true }),
		);
		expect(FakeEventSource.instances).toHaveLength(1);
		emit(FakeEventSource.instances[0], "update");
		expect(first).toHaveBeenCalledWith({ type: "update" });
		expect(second).toHaveBeenCalledWith({ type: "update" });
	});

	it("passes a drop on only to the screens that asked about drops", () => {
		const asked = vi.fn();
		const quiet = vi.fn();
		// The screen holding the stream did not ask; the other one did.
		renderHook(() =>
			useServerEvents("/events", ["update"], quiet, { shared: true }),
		);
		renderHook(() =>
			useServerEvents("/events", ["update", "disconnected"], asked, {
				shared: true,
			}),
		);
		expect(FakeEventSource.instances).toHaveLength(1);
		FakeEventSource.instances[0].onerror?.();
		expect(asked).toHaveBeenCalledWith({ type: "disconnected" });
		expect(quiet).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1000);
		// The holder reconnects; the other screen still holds no stream.
		expect(FakeEventSource.instances).toHaveLength(2);
	});

	it("hands the stream to the next screen when the first one closes", async () => {
		const first = vi.fn();
		const second = vi.fn();
		const leader = renderHook(() =>
			useServerEvents("/events", ["update"], first, { shared: true }),
		);
		renderHook(() =>
			useServerEvents("/events", ["update"], second, { shared: true }),
		);
		const held = FakeEventSource.instances[0];
		leader.unmount();
		expect(held.closed).toBe(true);
		await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
		emit(FakeEventSource.instances[1], "connected");
		expect(second).toHaveBeenCalledWith({ type: "connected" });
		expect(first).not.toHaveBeenCalled();
	});

	it("keeps one stream per screen when sharing is not asked for", () => {
		renderHook(() => useServerEvents("/events", ["update"], vi.fn()));
		renderHook(() => useServerEvents("/events", ["update"], vi.fn()));
		expect(FakeEventSource.instances).toHaveLength(2);
	});
});
