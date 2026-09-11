// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { DembraneEventCta } from "./DembraneEventCta";

const capture = vi.fn();

vi.mock("posthog-js", () => ({
	default: {
		capture: (...args: unknown[]) => capture(...args),
	},
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
	// jsdom cannot navigate; the click is still delivered to React's handler.
	document.addEventListener("click", (event) => event.preventDefault(), true);
});

afterEach(() => {
	cleanup();
	capture.mockClear();
});

const wrap = (
	node: React.ReactNode,
	path = "/en-US/p1/conversation/c1/finish",
) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<MemoryRouter initialEntries={[path]}>
					<Routes>
						<Route
							element={node}
							path="/:language/:projectId/conversation/:conversationId/finish"
						/>
					</Routes>
				</MemoryRouter>
			</MantineProvider>
		</I18nProvider>,
	);

it("shows the illustration and one button, and asks nothing itself", () => {
	wrap(<DembraneEventCta projectId="p1" />);

	// The question is the button. No heading above it, no reasons below.
	expect(screen.getByTestId("portal-finish-event-cta-art")).toBeTruthy();
	expect(screen.getByTestId("portal-finish-event-cta-button").textContent).toBe(
		"dembrane at your event?",
	);
	expect(
		screen.getByTestId("portal-finish-event-cta").textContent,
	).not.toContain("run an event");
	// No form of its own: the website's needs form is the form.
	expect(screen.queryByTestId("pricing-configurator-modal")).toBeNull();
	expect(capture).not.toHaveBeenCalled();
});

it("links to the email step of the website's needs form in a new tab, carrying the project", () => {
	wrap(<DembraneEventCta projectId="p1" />);

	const button = screen.getByTestId("portal-finish-event-cta-button");
	expect(button.getAttribute("href")).toBe(
		"https://www.dembrane.com/pricing?project=p1&step=2#needs",
	);
	expect(button.getAttribute("target")).toBe("_blank");
	expect(button.getAttribute("rel")).toContain("noopener");

	fireEvent.click(button);
	expect(capture).toHaveBeenCalledWith("portal_event_cta_clicked", {
		project_id: "p1",
	});
});

it("sends a Dutch participant to the Dutch form", () => {
	wrap(<DembraneEventCta projectId="p1" />, "/nl-NL/p1/conversation/c1/finish");

	expect(
		screen.getByTestId("portal-finish-event-cta-button").getAttribute("href"),
	).toBe("https://www.dembrane.com/nl/pricing?project=p1&step=2#needs");
});
