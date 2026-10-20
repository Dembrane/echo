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
vi.mock("@/components/participant/InAppBrowserNotice", () => ({
	InAppBrowserNotice: () => null,
}));
vi.mock("@/components/participant/ParticipantOnboardingCards", () => ({
	default: () => <div data-testid="onboarding" />,
}));
vi.mock("@/components/participant/hooks", () => ({
	useParticipantProjectById: () => ({
		data: { id: "p-1", is_taking_recordings: false },
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
	expect(screen.getByTestId("portal-not-taking-recordings")).toBeTruthy();
	const header = screen.getByTestId("portal-header");
	expect(header.className).toContain("mx-auto");
	expect(header.contains(screen.getByTestId("logo"))).toBe(true);
	expect(screen.queryByTestId("onboarding")).toBeNull();
});
