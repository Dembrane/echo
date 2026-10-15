// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";

const cfg = vi.hoisted(() => ({
	APP_ENVIRONMENT: "production",
	PREVIEW_PR: null as { number: number; url: string } | null,
	REGION: undefined as "eu" | undefined,
}));

vi.mock("@/config", async (importOriginal) => ({
	...(await importOriginal<object>()),
	get APP_ENVIRONMENT() {
		return cfg.APP_ENVIRONMENT;
	},
	get PREVIEW_PR() {
		return cfg.PREVIEW_PR;
	},
	get REGION() {
		return cfg.REGION;
	},
}));
vi.mock("@/hooks/useWhitelabelLogo", () => ({
	useWhitelabelLogo: () => ({ logoUrl: null }),
}));

import { LogoDembrane } from "@/components/common/Logo";
import { Footer } from "@/components/layout/Footer";

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
	cfg.APP_ENVIRONMENT = "production";
	cfg.PREVIEW_PR = null;
	cfg.REGION = undefined;
});

const wrap = (ui: React.ReactNode) =>
	render(
		<MantineProvider>
			<I18nProvider i18n={i18n}>
				<MemoryRouter>{ui}</MemoryRouter>
			</I18nProvider>
		</MantineProvider>,
	);

it("shows no badge on production without a region", () => {
	wrap(<LogoDembrane />);
	expect(screen.queryByText("EU")).toBeNull();
});

it("shows EU under the logo on the EU deployment", () => {
	cfg.REGION = "eu";
	wrap(<LogoDembrane />);
	expect(screen.getByText("EU")).toBeTruthy();
});

it("keeps the environment badge ahead of EU", () => {
	cfg.REGION = "eu";
	cfg.APP_ENVIRONMENT = "staging";
	wrap(<LogoDembrane />);
	expect(screen.getByText("Staging")).toBeTruthy();
	expect(screen.queryByText("EU")).toBeNull();
});

it("keeps the PR badge ahead of everything", () => {
	cfg.REGION = "eu";
	cfg.PREVIEW_PR = { number: 7, url: "https://example.com/pull/7" };
	wrap(<LogoDembrane />);
	expect(screen.getByTestId("logo-preview-pr")).toBeTruthy();
	expect(screen.queryByText("EU")).toBeNull();
});

it("adds the hosted line to the footer only on the EU deployment", () => {
	wrap(<Footer />);
	expect(screen.queryByText("Proudly hosted in the EU")).toBeNull();
	cleanup();
	cfg.REGION = "eu";
	wrap(<Footer />);
	expect(screen.getByText("Proudly hosted in the EU")).toBeTruthy();
});
