// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";

/** A PR preview names its pull request under the logo and in the sign-in
 * footer. next and prod carry no previewPr in /runtime-config.js and render as
 * before: their env badge (or none), and no footer line. */

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
	window.matchMedia = vi.fn().mockImplementation((query: string) => ({
		addEventListener: vi.fn(),
		addListener: vi.fn(),
		dispatchEvent: vi.fn(),
		matches: false,
		media: query,
		onchange: null,
		removeEventListener: vi.fn(),
		removeListener: vi.fn(),
	}));
});

afterEach(() => {
	cleanup();
	delete (globalThis as { __ECHO_RUNTIME__?: unknown }).__ECHO_RUNTIME__;
	vi.resetModules();
});

// config.ts reads the runtime config once, at import, as the page does.
const renderWith = async (runtime: Record<string, unknown>) => {
	(globalThis as { __ECHO_RUNTIME__?: unknown }).__ECHO_RUNTIME__ = {
		apiBase: "/api",
		dashboardUrl: "https://dashboard.example",
		portalUrl: "https://portal.example",
		role: "dashboard",
		...runtime,
	};
	const { Logo } = await import("./Logo");
	const { Footer } = await import("@/components/layout/Footer");
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<MemoryRouter>
					<Logo hideTitle={false} alwaysDembrane to="/o" />
					<Footer />
				</MemoryRouter>
			</MantineProvider>
		</I18nProvider>,
	);
};

it("a PR preview shows and links its PR under the logo and in the footer", async () => {
	await renderWith({
		env: "testing",
		previewPr: 1234,
		previewRepo: "Dembrane/echo",
	});
	const url = "https://github.com/Dembrane/echo/pull/1234";

	const badge = screen.getByTestId("logo-preview-pr");
	expect(badge.textContent).toBe("PR #1234");
	expect(badge.getAttribute("href")).toBe(url);
	expect(screen.queryByText("testing")).toBeNull();

	const footer = screen.getByTestId("footer-preview-pr");
	expect(footer.textContent).toBe("Preview of PR #1234");
	expect(footer.getAttribute("href")).toBe(url);

	// The badge is a sibling of the home link, never inside it.
	expect(badge.parentElement?.closest("a")).toBeNull();
	expect(
		screen
			.getByRole("img", { name: "Logo" })
			.closest("a")
			?.getAttribute("href"),
	).toBe("/en-US/o");
});

it("next keeps its env badge and has no PR badge or footer line", async () => {
	await renderWith({ env: "staging" });
	expect(screen.getByText("staging")).toBeTruthy();
	expect(screen.queryByTestId("logo-preview-pr")).toBeNull();
	expect(screen.queryByTestId("footer-preview-pr")).toBeNull();
});

it("prod has no badge and no footer line", async () => {
	await renderWith({ env: "production" });
	expect(screen.queryByText("production")).toBeNull();
	expect(screen.queryByTestId("logo-preview-pr")).toBeNull();
	expect(screen.queryByTestId("footer-preview-pr")).toBeNull();
});
