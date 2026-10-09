// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useDocumentHidden } from "./useDocumentHidden";

const setHidden = (hidden: boolean) =>
	Object.defineProperty(document, "hidden", {
		configurable: true,
		value: hidden,
	});

afterEach(() => {
	cleanup();
	setHidden(false);
});

it("starts from the current visibility", () => {
	setHidden(true);
	const { result } = renderHook(() => useDocumentHidden());
	expect(result.current).toBe(true);
});

it("follows visibility changes", () => {
	const { result } = renderHook(() => useDocumentHidden());
	expect(result.current).toBe(false);

	setHidden(true);
	act(() => {
		document.dispatchEvent(new Event("visibilitychange"));
	});
	expect(result.current).toBe(true);

	setHidden(false);
	act(() => {
		document.dispatchEvent(new Event("visibilitychange"));
	});
	expect(result.current).toBe(false);
});

it("rechecks on pagehide, which some browsers send without a visibilitychange", () => {
	const { result } = renderHook(() => useDocumentHidden());

	setHidden(true);
	act(() => {
		window.dispatchEvent(new Event("pagehide"));
	});
	expect(result.current).toBe(true);
});
