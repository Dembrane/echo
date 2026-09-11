// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { DembraneEventCta } from "./DembraneEventCta";

const capture = vi.fn();

vi.mock("posthog-js", () => ({
	default: {
		capture: (...args: unknown[]) => capture(...args),
		// The configurator's price anchor reads a flag. Unresolved here.
		getFeatureFlag: () => undefined,
		getFeatureFlagPayload: () => undefined,
		onFeatureFlags: () => () => {},
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

	if (!globalThis.ResizeObserver) {
		globalThis.ResizeObserver = class {
			disconnect() {}
			observe() {}
			unobserve() {}
		};
	}
	globalThis.scrollTo = globalThis.scrollTo ?? (() => {});
});

afterEach(() => {
	cleanup();
	capture.mockClear();
	sessionStorage.clear();
});

const wrap = (node: React.ReactNode) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<MemoryRouter initialEntries={["/en-US/p1/conversation/c1/finish"]}>
					{node}
				</MemoryRouter>
			</MantineProvider>
		</I18nProvider>,
	);

it("shows the illustration and one button, and asks nothing yet", () => {
	wrap(<DembraneEventCta projectId="p1" />);

	// The question is the button. No heading above it, no reasons below.
	expect(screen.getByTestId("portal-finish-event-cta-art")).toBeTruthy();
	expect(screen.queryByTestId("portal-finish-event-cta-reasons")).toBeNull();
	expect(screen.getByTestId("portal-finish-event-cta-button").textContent).toBe(
		"dembrane at your event?",
	);
	expect(
		screen.getByTestId("portal-finish-event-cta").textContent,
	).not.toContain("run an event");
	// The form waits for the click: no opening step, nothing reported.
	expect(screen.queryByTestId("pricing-configurator-opening")).toBeNull();
	expect(capture).not.toHaveBeenCalled();
});

it("opens the intake form on the click, and its opening asks for an email, not for a plan", async () => {
	wrap(<DembraneEventCta projectId="p1" />);

	fireEvent.click(screen.getByTestId("portal-finish-event-cta-button"));

	expect(capture).toHaveBeenCalledWith("portal_event_cta_clicked", {
		project_id: "p1",
	});
	const opening = await screen.findByTestId("pricing-configurator-opening");
	expect(opening.textContent).toBe(
		"Leave your email so we can get in touch with you.",
	);
	expect(screen.getByTestId("pricing-configurator-email")).toBeTruthy();
	const modal = screen.getByTestId("pricing-configurator-modal");
	expect(modal.textContent).not.toMatch(/free plan|paid plan/i);
	// The configurator's own events ride on the portal's PostHog, tagged.
	expect(capture).toHaveBeenCalledWith(
		"pricing_config_started",
		expect.objectContaining({
			mount: "portal",
			project_id: "p1",
			surface: "participant_portal",
		}),
	);
});
