// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoSave } from "./useAutoSave";

const deferred = () => {
	let resolve: () => void = () => {};
	let reject: (error: Error) => void = () => {};
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, reject, resolve };
};

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("useAutoSave", () => {
	it("keeps a newer edit pending when an older save finishes late", async () => {
		const first = deferred();
		const second = deferred();
		const onSave = vi.fn((value: string) =>
			value === "first" ? first.promise : second.promise,
		);
		const { result } = renderHook(() => useAutoSave({ onSave }));

		act(() => result.current.dispatchAutoSave("first"));
		act(() => vi.advanceTimersByTime(1_000));
		expect(onSave).toHaveBeenCalledWith("first");
		expect(result.current.isSaving).toBe(true);

		act(() => result.current.dispatchAutoSave("second"));
		expect(result.current.isPendingSave).toBe(true);
		await act(async () => first.resolve());

		expect(result.current.isPendingSave).toBe(true);
		expect(result.current.isSaving).toBe(false);
		act(() => vi.advanceTimersByTime(1_000));
		expect(onSave).toHaveBeenLastCalledWith("second");
		await act(async () => second.resolve());
		expect(result.current.isPendingSave).toBe(false);
	});

	it("manual flush cancels the debounce and reports a failed save", async () => {
		const failure = new Error("offline");
		const onSave = vi.fn().mockRejectedValue(failure);
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { result } = renderHook(() => useAutoSave({ onSave }));

		act(() => result.current.dispatchAutoSave("draft"));
		let saved = true;
		await act(async () => {
			saved = await result.current.triggerManualSave("draft");
		});

		expect(saved).toBe(false);
		expect(result.current.isError).toBe(true);
		expect(result.current.isPendingSave).toBe(true);
		expect(onSave).toHaveBeenCalledOnce();
		act(() => vi.advanceTimersByTime(1_000));
		expect(onSave).toHaveBeenCalledOnce();
	});
	it("saves a pending edit at once when its field unmounts", async () => {
		const onSave = vi.fn().mockResolvedValue(undefined);
		const { result, unmount } = renderHook(() => useAutoSave({ onSave }));

		act(() => result.current.dispatchAutoSave("typed just before leaving"));
		expect(onSave).not.toHaveBeenCalled();
		unmount();

		expect(onSave).toHaveBeenCalledExactlyOnceWith("typed just before leaving");
		act(() => vi.advanceTimersByTime(1_000));
		expect(onSave).toHaveBeenCalledOnce();
	});

	it("has nothing to save on unmount once the debounce has fired", async () => {
		const onSave = vi.fn().mockResolvedValue(undefined);
		const { result, unmount } = renderHook(() => useAutoSave({ onSave }));

		act(() => result.current.dispatchAutoSave("saved"));
		await act(async () => vi.advanceTimersByTime(1_000));
		unmount();

		expect(onSave).toHaveBeenCalledOnce();
	});
});
