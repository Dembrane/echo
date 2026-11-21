// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { usePendingUploads } from "./usePendingUploads";

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

const deferred = () => {
	let resolve: () => void = () => {};
	let reject: (error: Error) => void = () => {};
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, reject, resolve };
};

it("is done straight away, after the grace period, with nothing in flight", async () => {
	const { result } = renderHook(() => usePendingUploads());

	const wait = result.current.waitForAll();
	await vi.advanceTimersByTimeAsync(100);

	await expect(wait).resolves.toBe("done");
});

it("counts an upload until it settles", async () => {
	const { result } = renderHook(() => usePendingUploads());
	const upload = deferred();

	act(() => result.current.track(upload.promise));
	expect(result.current.count()).toBe(1);

	upload.resolve();
	await vi.advanceTimersByTimeAsync(0);
	expect(result.current.count()).toBe(0);
});

it("tracks an upload handed over during the grace period", async () => {
	const { result } = renderHook(() => usePendingUploads());
	const finalChunk = deferred();

	const wait = result.current.waitForAll();
	result.current.track(finalChunk.promise);
	await vi.advanceTimersByTimeAsync(100);

	let settled = false;
	void wait.then(() => {
		settled = true;
	});
	await vi.advanceTimersByTimeAsync(1000);
	expect(settled).toBe(false);

	finalChunk.resolve();
	await expect(wait).resolves.toBe("done");
});

it("treats a failed upload as settled, not as something to keep waiting on", async () => {
	const { result } = renderHook(() => usePendingUploads());
	const upload = deferred();
	// The caller handles the failure; the tracker must not leave its own
	// rejection unhandled.
	upload.promise.catch(() => {});
	result.current.track(upload.promise);

	const wait = result.current.waitForAll();
	upload.reject(new Error("upload failed"));
	await vi.advanceTimersByTimeAsync(100);

	await expect(wait).resolves.toBe("done");
	expect(result.current.count()).toBe(0);
});

it("gives up after 30 seconds", async () => {
	const { result } = renderHook(() => usePendingUploads());
	result.current.track(new Promise(() => {}));

	const wait = result.current.waitForAll();
	await vi.advanceTimersByTimeAsync(100 + 29_999);
	let settled = false;
	void wait.then(() => {
		settled = true;
	});
	await vi.advanceTimersByTimeAsync(0);
	expect(settled).toBe(false);

	await vi.advanceTimersByTimeAsync(1);
	await expect(wait).resolves.toBe("timeout");
	expect(result.current.count()).toBe(1);
});
