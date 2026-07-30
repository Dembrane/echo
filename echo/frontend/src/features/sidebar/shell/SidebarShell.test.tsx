// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SidebarShell } from "./SidebarShell";

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

const renderShell = () =>
	render(
		<MemoryRouter>
			<SidebarShell>content</SidebarShell>
		</MemoryRouter>,
	);

it("desktop: stays an in-flow rail with no backdrop", () => {
	stubMatchMedia(false);
	renderShell();
	expect(screen.queryByTestId("sidebar-mobile-backdrop")).toBeNull();
	const aside = document.querySelector("aside");
	expect(aside?.className).toContain("relative");
	expect(aside?.className).not.toContain("fixed");
	expect(aside?.getAttribute("role")).toBeNull();
});

it("mobile open: fixed overlay dialog with backdrop", () => {
	stubMatchMedia(true);
	renderShell();
	act(() => {
		window.localStorage.setItem("dembrane.sidebar.collapsed", "false");
		window.dispatchEvent(
			new CustomEvent("dembrane.sidebar.local-state", {
				detail: { key: "dembrane.sidebar.collapsed", value: false },
			}),
		);
	});
	expect(screen.getByTestId("sidebar-mobile-backdrop")).toBeTruthy();
	const aside = document.querySelector("aside");
	expect(aside?.className).toContain("fixed");
	expect(aside?.className).not.toContain("relative");
	expect(aside?.getAttribute("role")).toBe("dialog");
	expect(aside?.getAttribute("aria-modal")).toBe("true");
});

it("mobile collapsed: hidden, no backdrop", () => {
	stubMatchMedia(true);
	window.localStorage.setItem("dembrane.sidebar.collapsed", "true");
	renderShell();
	expect(screen.queryByTestId("sidebar-mobile-backdrop")).toBeNull();
	const aside = document.querySelector("aside");
	expect(aside?.style.width).toBe("0px");
});

it("tapping the backdrop closes the drawer", () => {
	stubMatchMedia(true);
	renderShell();
	act(() => {
		window.localStorage.setItem("dembrane.sidebar.collapsed", "false");
		window.dispatchEvent(
			new CustomEvent("dembrane.sidebar.local-state", {
				detail: { key: "dembrane.sidebar.collapsed", value: false },
			}),
		);
	});
	fireEvent.click(screen.getByTestId("sidebar-mobile-backdrop"));
	expect(screen.queryByTestId("sidebar-mobile-backdrop")).toBeNull();
	expect(window.localStorage.getItem("dembrane.sidebar.collapsed")).toBe(
		"true",
	);
});
