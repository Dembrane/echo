// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MobileSidebarAutoClose } from "./MobileSidebarAutoClose";

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

const collapsed = () =>
	window.localStorage.getItem("dembrane.sidebar.collapsed");

const App = () => (
	<MemoryRouter initialEntries={["/a"]}>
		<MobileSidebarAutoClose />
		<Routes>
			<Route path="/a" element={<Link to="/b">go</Link>} />
			<Route path="/b" element={<div>b</div>} />
		</Routes>
	</MemoryRouter>
);

beforeEach(() => {
	window.localStorage.clear();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

it("closes the drawer on mount when mobile", () => {
	stubMatchMedia(true);
	render(<App />);
	expect(collapsed()).toBe("true");
});

it("does not touch state on desktop", () => {
	stubMatchMedia(false);
	render(<App />);
	fireEvent.click(screen.getByText("go"));
	expect(collapsed()).toBeNull();
});

it("closes the drawer again after navigation while mobile", () => {
	stubMatchMedia(true);
	render(<App />);
	window.localStorage.setItem("dembrane.sidebar.collapsed", "false");
	fireEvent.click(screen.getByText("go"));
	expect(collapsed()).toBe("true");
});
