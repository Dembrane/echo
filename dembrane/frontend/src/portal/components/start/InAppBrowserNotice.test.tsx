// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { InAppBrowserNotice } from "./InAppBrowserNotice";

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
});

afterEach(() => {
	cleanup();
	capture.mockClear();
	vi.unstubAllGlobals();
});

const renderWithUserAgent = (userAgent: string) => {
	vi.stubGlobal("navigator", { ...navigator, userAgent });
	return render(
		<StrictMode>
			<I18nProvider i18n={i18n}>
				<MantineProvider>
					<InAppBrowserNotice projectId="p1" />
				</MantineProvider>
			</I18nProvider>
		</StrictMode>,
	);
};

it("asks LinkedIn visitors on iPhone to open the portal in Safari", () => {
	renderWithUserAgent(
		"Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]/9.31.1230",
	);
	expect(screen.getByTestId("portal-in-app-browser-alert")).toBeTruthy();
	expect(screen.getByText(/inside LinkedIn/)).toBeTruthy();
	expect(screen.getByText(/in Safari from the app/)).toBeTruthy();
	expect(capture).toHaveBeenCalledTimes(1);
	expect(capture).toHaveBeenCalledWith("portal_in_app_browser_detected", {
		app: "linkedin",
		os: "ios",
		project_id: "p1",
	});
});

it("shows nothing in a real browser", () => {
	const { container } = renderWithUserAgent(
		"Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
	);
	expect(screen.queryByTestId("portal-in-app-browser-alert")).toBeNull();
	// No element at all (MantineProvider adds only its style tag), so nothing can shift.
	expect(container.querySelectorAll(":scope > :not(style)")).toHaveLength(0);
	expect(capture).not.toHaveBeenCalled();
});
