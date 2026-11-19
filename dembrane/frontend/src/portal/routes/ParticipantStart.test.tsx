// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen } from "@testing-library/react";
import posthog from "posthog-js";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { ParticipantStartRoute } from "./ParticipantStart";

vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));
vi.mock("@/hooks/useVisitorBeacon", () => ({ useVisitorBeacon: vi.fn() }));
vi.mock("@/components/common/Logo", () => ({
	// The logomark is an image URL, not a component: the spinner puts it in <img src>.
	DembraneLogomark: "logomark.svg",
	Logo: () => <div data-testid="logo" />,
}));
vi.mock("@/portal/components/start/InAppBrowserNotice", () => ({
	InAppBrowserNotice: () => null,
}));
vi.mock("@/portal/components/start/ParticipantOnboardingCards", () => ({
	default: () => <div data-testid="onboarding" />,
}));
const project = vi.hoisted(() => ({
	current: { id: "p-1", is_ai_available: true, is_taking_recordings: false },
}));
const query = vi.hoisted(() => ({
	error: null as unknown,
	isLoading: false,
}));
vi.mock("@/portal/hooks/useParticipantProjectById", () => ({
	useParticipantProjectById: () => ({
		data: query.isLoading ? undefined : project.current,
		error: query.error,
		isLoading: query.isLoading,
	}),
}));

beforeAll(() => {
	i18n.load("en-US", {});
	i18n.activate("en-US");
	window.matchMedia =
		window.matchMedia ||
		((query: string) => ({
			addEventListener: () => {},
			addListener: () => {},
			dispatchEvent: () => false,
			matches: false,
			media: query,
			onchange: null,
			removeEventListener: () => {},
			removeListener: () => {},
		}));
});

afterEach(() => {
	cleanup();
	query.error = null;
	query.isLoading = false;
	vi.mocked(posthog.capture).mockClear();
	project.current = {
		id: "p-1",
		is_ai_available: true,
		is_taking_recordings: false,
	};
});

const startTree = (path = "/p-1/start") => (
	<I18nProvider i18n={i18n}>
		<MantineProvider>
			<MemoryRouter initialEntries={[path]}>
				<Routes>
					<Route path="/:projectId/start" element={<ParticipantStartRoute />} />
				</Routes>
			</MemoryRouter>
		</MantineProvider>
	</I18nProvider>
);
const renderStart = (path?: string) => render(startTree(path));

it("lets typed text start while only recording is closed", () => {
	renderStart("/p-1/start?mode=text");
	expect(screen.getByTestId("onboarding")).toBeTruthy();
	expect(screen.queryByTestId("portal-not-taking-recordings")).toBeNull();
});

it("shows typed text the same not-taking-recordings page once AI is unavailable", () => {
	project.current = {
		id: "p-1",
		is_ai_available: false,
		is_taking_recordings: false,
	};
	renderStart("/p-1/start?mode=text");
	// Text mode records nothing, so it says responses; no plan or budget words.
	expect(screen.getByTestId("portal-not-taking-recordings").textContent).toBe(
		"This project isn't taking responses right now.",
	);
	expect(screen.queryByTestId("onboarding")).toBeNull();
});

it("shows the not-taking-recordings page under the portal logo", () => {
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<MemoryRouter initialEntries={["/p-1/start"]}>
					<Routes>
						<Route
							path="/:projectId/start"
							element={<ParticipantStartRoute />}
						/>
					</Routes>
				</MemoryRouter>
			</MantineProvider>
		</I18nProvider>,
	);
	expect(screen.getByTestId("portal-not-taking-recordings").textContent).toBe(
		"This project isn't taking recordings right now.",
	);
	const header = screen.getByTestId("portal-header");
	expect(header.className).toContain("mx-auto");
	expect(header.contains(screen.getByTestId("logo"))).toBe(true);
	expect(screen.queryByTestId("onboarding")).toBeNull();
});

it("shows the spinner while the project loads, then the deck", () => {
	project.current = { ...project.current, is_taking_recordings: true };
	query.isLoading = true;
	const view = renderStart();
	expect(screen.getByTestId("portal-loading-spinner")).toBeTruthy();

	query.isLoading = false;
	view.rerender(startTree());
	expect(screen.getByTestId("onboarding")).toBeTruthy();
});

it("says the portal failed to load when the project can't be fetched", () => {
	query.error = new Error("404");
	renderStart();
	expect(screen.getByTestId("portal-error-alert")).toBeTruthy();
});

it("counts the landing once, after the project loads", () => {
	query.isLoading = true;
	const view = renderStart();
	expect(posthog.capture).not.toHaveBeenCalled();

	query.isLoading = false;
	view.rerender(startTree());
	view.rerender(startTree());
	expect(
		vi
			.mocked(posthog.capture)
			.mock.calls.filter(([event]) => event === "portal_landed"),
	).toEqual([["portal_landed", { project_id: "p-1" }]]);
});
