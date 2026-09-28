// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MOBILE_MEDIA_QUERY, useIsMobile } from "./useIsMobile";

function stubMatchMedia(matches: boolean) {
	const mql = {
		addEventListener: vi.fn(),
		addListener: vi.fn(),
		dispatchEvent: vi.fn(),
		matches,
		media: MOBILE_MEDIA_QUERY,
		onchange: null,
		removeEventListener: vi.fn(),
		removeListener: vi.fn(),
	};
	vi.stubGlobal("matchMedia", vi.fn().mockReturnValue(mql));
}

const Probe = () => <div data-testid="probe">{String(useIsMobile())}</div>;

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

it("is true below the md breakpoint", () => {
	stubMatchMedia(true);
	render(<Probe />);
	expect(screen.getByTestId("probe").textContent).toBe("true");
});

it("is false at md and above", () => {
	stubMatchMedia(false);
	render(<Probe />);
	expect(screen.getByTestId("probe").textContent).toBe("false");
});

it("queries exactly the Tailwind md breakpoint", () => {
	stubMatchMedia(false);
	render(<Probe />);
	expect(window.matchMedia).toHaveBeenCalledWith("(max-width: 767px)");
});
