// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRecordingWakeLock } from "./useRecordingWakeLock";

const wakeLock = {
	disableAutoReacquire: vi.fn(),
	enableAutoReacquire: vi.fn(),
	isSupported: true,
	obtainWakeLock: vi.fn(),
	releaseWakeLock: vi.fn(),
};

vi.mock("@/hooks/useWakeLock", () => ({ useWakeLock: () => wakeLock }));

beforeEach(() => {
	wakeLock.isSupported = true;
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

it("holds the lock and keeps re-acquiring it", () => {
	const { result } = renderHook(() => useRecordingWakeLock());

	result.current.hold();

	expect(wakeLock.obtainWakeLock).toHaveBeenCalledTimes(1);
	expect(wakeLock.enableAutoReacquire).toHaveBeenCalledTimes(1);
});

it("does nothing on hold when the browser has no wake lock", () => {
	wakeLock.isSupported = false;
	const { result } = renderHook(() => useRecordingWakeLock());

	result.current.hold();

	expect(result.current.isSupported).toBe(false);
	expect(wakeLock.obtainWakeLock).not.toHaveBeenCalled();
	expect(wakeLock.enableAutoReacquire).not.toHaveBeenCalled();
});

it("releases the lock and stops re-acquiring it", () => {
	const { result } = renderHook(() => useRecordingWakeLock());

	result.current.release();

	expect(wakeLock.releaseWakeLock).toHaveBeenCalledTimes(1);
	expect(wakeLock.disableAutoReacquire).toHaveBeenCalledTimes(1);
});
