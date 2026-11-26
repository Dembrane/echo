// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { VerifyEmailRoute } from "./VerifyEmail";

const { session, verify } = vi.hoisted(() => ({
	session: vi.fn<() => Promise<boolean>>(),
	verify: vi.fn<(token: string) => Promise<void>>(),
}));
vi.mock("@/lib/auth", async (original) => ({
	...(await original<typeof import("@/lib/auth")>()),
	hasSession: session,
	verifyEmail: verify,
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
	session.mockReset();
	verify.mockReset();
});

const open = (path = "/verify-email?token=abc") =>
	render(
		<QueryClientProvider
			client={
				new QueryClient({ defaultOptions: { queries: { retry: false } } })
			}
		>
			<I18nProvider i18n={i18n}>
				<MantineProvider>
					<MemoryRouter initialEntries={[path]}>
						<VerifyEmailRoute />
					</MemoryRouter>
				</MantineProvider>
			</I18nProvider>
		</QueryClientProvider>,
	);

it("signed out: the link verifies and the page says so", async () => {
	session.mockResolvedValue(false);
	verify.mockResolvedValue();
	open();
	await screen.findByText(/Your email is verified/);
	expect(verify).toHaveBeenCalledWith("abc");
});

it("someone else signed in: the link still verifies its own address, and says whose session stays", async () => {
	session.mockResolvedValue(true);
	verify.mockResolvedValue();
	open();
	await screen.findByText(
		/The email address this link was sent to is verified/,
	);
	expect(verify).toHaveBeenCalledWith("abc");
	expect(screen.queryByText(/already verified/)).toBeNull();
	expect(screen.getByRole("button", { name: "Go to dashboard" })).toBeTruthy();
});

it("signed in, their own link clicked again: already verified, no error", async () => {
	session.mockResolvedValue(true);
	verify.mockRejectedValue(new Error("INVALID_TOKEN"));
	open();
	await screen.findByText("Your email is already verified");
	expect(screen.queryByText("This link is no longer valid")).toBeNull();
});

it("signed out, a used link: no longer valid, with Log in", async () => {
	session.mockResolvedValue(false);
	verify.mockRejectedValue(new Error("INVALID_TOKEN"));
	open();
	await screen.findByText("This link is no longer valid");
	expect(screen.getByRole("button", { name: "Log in" })).toBeTruthy();
});

it("no token: nothing is verified", async () => {
	session.mockResolvedValue(true);
	open("/verify-email");
	await screen.findByText(/Please open the link from your email/);
	await waitFor(() => expect(session).toHaveBeenCalled());
	expect(verify).not.toHaveBeenCalled();
});
