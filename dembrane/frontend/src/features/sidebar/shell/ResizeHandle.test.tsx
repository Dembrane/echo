// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ResizeHandle } from "./ResizeHandle";

function stubMatchMedia(matches: boolean) {
	const mql = {
		addEventListener: vi.fn(),
		addListener: vi.fn(),
		dispatchEvent: vi.fn(),
		matches,
		media: "(max-width: 767px)",
		onchange: null,
		removeEventListener: vi.fn(),
		removeListener: vi.fn(),
	};
	vi.stubGlobal("matchMedia", vi.fn().mockReturnValue(mql));
}

beforeEach(() => {
	window.localStorage.clear();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

it("renders the resize grip on desktop", () => {
	stubMatchMedia(false);
	render(<ResizeHandle />);
	expect(screen.getByRole("separator")).toBeTruthy();
});

it("renders nothing on mobile", () => {
	stubMatchMedia(true);
	render(<ResizeHandle />);
	expect(screen.queryByRole("separator")).toBeNull();
});
