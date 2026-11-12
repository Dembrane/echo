// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useElementOnScreen } from "./useElementOnScreen";

// The observer the hook made, so a test can report what it sees.
let report: (isIntersecting: boolean) => void = () => {};

beforeEach(() => {
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			constructor(callback: IntersectionObserverCallback) {
				report = (isIntersecting) =>
					callback(
						[{ isIntersecting } as IntersectionObserverEntry],
						this as unknown as IntersectionObserver,
					);
			}
			disconnect() {}
			observe() {}
			unobserve() {}
		},
	);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

it("counts the element on screen until the observer says otherwise", () => {
	// Starting off screen flashed the portal's scroll-to-bottom arrow on load.
	const { result } = renderHook(() => useElementOnScreen({}));

	expect(result.current[1]).toBe(true);

	act(() => report(false));
	expect(result.current[1]).toBe(false);

	act(() => report(true));
	expect(result.current[1]).toBe(true);
});
