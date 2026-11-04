// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { AccountsApiError } from "../api/client";
import type { AccountEmailT } from "../contract/contract.gen";
import { accountEmail } from "../contract/fixtures.gen";
import { EmailSection } from "./EmailSection";

const state: { data?: AccountEmailT; error?: unknown } = {};
vi.mock("../api/hooks", () => ({
	useAccountEmail: () => ({
		data: state.data,
		error: state.error ?? null,
		isLoading: false,
		refresh: async () => {},
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
	state.data = undefined;
	state.error = undefined;
});

const wrap = () =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<EmailSection orgId="org" />
			</MantineProvider>
		</I18nProvider>,
	);

it("shows the newest thread as a chat with a Gmail button per mailbox", () => {
	state.data = accountEmail;
	wrap();
	expect(screen.getByText("Pilot in March")).toBeTruthy();
	expect(
		screen.getByText(
			"Could we start the pilot in March? The council meets on the 12th.",
		),
	).toBeTruthy();
	expect(
		screen.getByText("March works. I'll send the offer this week."),
	).toBeTruthy();
	const links = screen
		.getAllByTestId("email-open-gmail")
		.map((a) => a.getAttribute("href"));
	expect(links).toEqual(accountEmail.threads[0]?.gmail.map((g) => g.url));
	// Collapsing hides the bubbles.
	fireEvent.click(screen.getByText("Pilot in March"));
	expect(
		screen.queryByText("March works. I'll send the offer this week."),
	).toBe(null);
});

it("says when email is not connected here", () => {
	state.error = new AccountsApiError(503, "Email is not connected here");
	wrap();
	expect(
		screen.getByText("Email is not connected in this environment."),
	).toBeTruthy();
});

it("says what it matched on when there is no mail", () => {
	state.data = { ...accountEmail, threads: [] };
	wrap();
	expect(
		screen.getByText(
			"No email with example-town.example in the last two years.",
		),
	).toBeTruthy();
});
