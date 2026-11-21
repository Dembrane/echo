// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { ParticipantStartRoute } from "./ParticipantStart";

vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));
vi.mock("@/hooks/useVisitorBeacon", () => ({ useVisitorBeacon: vi.fn() }));
vi.mock("@/components/common/Logo", () => ({
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
vi.mock("@/portal/hooks/useParticipantProjectById", () => ({
	useParticipantProjectById: () => ({
		data: project.current,
		error: null,
		isLoading: false,
	}),
}));

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
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
	project.current = {
		id: "p-1",
		is_ai_available: true,
		is_taking_recordings: false,
	};
});

const renderStart = (path = "/p-1/start") =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<MemoryRouter initialEntries={[path]}>
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
