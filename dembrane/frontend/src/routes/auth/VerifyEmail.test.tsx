// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { VerifyEmailRoute } from "./VerifyEmail";

const { navigate, session, verify } = vi.hoisted(() => ({
	navigate: vi.fn(),
	session: vi.fn<() => Promise<boolean>>(),
	verify: vi.fn<(token: string) => Promise<void>>(),
}));
vi.mock("@/hooks/useI18nNavigate", () => ({ useI18nNavigate: () => navigate }));
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
	navigate.mockReset();
	session.mockReset();
	verify.mockReset();
});

const open = (
	path = "/verify-email?token=abc",
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) =>
	render(
		<QueryClientProvider client={client}>
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

it("signed in, their own link clicked again: the server answers verified, and so does the page", async () => {
	session.mockResolvedValue(true);
	verify.mockResolvedValue();
	open();
	await screen.findByText(
		/The email address this link was sent to is verified/,
	);
	expect(screen.queryByText("This link is no longer valid")).toBeNull();
});

it("signed in, an expired link: no longer valid, and nothing is said about whose address is verified", async () => {
	session.mockResolvedValue(true);
	verify.mockRejectedValue(new Error("TOKEN_EXPIRED"));
	open();
	await screen.findByText("This link is no longer valid");
	screen.getByText(/You are still signed in to your own account here/);
	expect(screen.queryByText(/already verified/)).toBeNull();
	expect(screen.getByRole("button", { name: "Go to dashboard" })).toBeTruthy();
	expect(screen.queryByRole("button", { name: "Log in" })).toBeNull();
});

it("signed out, an expired link: no longer valid, with Log in", async () => {
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

// In the app the session is known before this page mounts, so the call fires
// during StrictMode's double mount (dev).
const strictWithSession = (signedIn: boolean) => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	if (signedIn) client.setQueryData(["auth", "session"], true);
	else
		client
			.getQueryCache()
			.build(client, { queryKey: ["auth", "session"] })
			.setState({ error: new Error("No session"), status: "error" });
	return render(
		<StrictMode>
			<QueryClientProvider client={client}>
				<I18nProvider i18n={i18n}>
					<MantineProvider>
						<MemoryRouter initialEntries={["/verify-email?token=abc"]}>
							<VerifyEmailRoute />
						</MemoryRouter>
					</MantineProvider>
				</I18nProvider>
			</QueryClientProvider>
		</StrictMode>,
	);
};

it("StrictMode, session known at mount: the answer reaches the page", async () => {
	verify.mockResolvedValue();
	strictWithSession(true);
	await screen.findByText(
		/The email address this link was sent to is verified/,
	);
	expect(verify).toHaveBeenCalledTimes(1);
});

it("StrictMode, session known at mount, a broken link: the page says so", async () => {
	verify.mockRejectedValue(new Error("INVALID_TOKEN"));
	strictWithSession(true);
	await screen.findByText("This link is no longer valid");
	expect(verify).toHaveBeenCalledTimes(1);
});

it("StrictMode, signed out at mount: the answer reaches the page", async () => {
	verify.mockResolvedValue();
	strictWithSession(false);
	await screen.findByText(/Your email is verified/);
	expect(verify).toHaveBeenCalledTimes(1);
});

it("signed out: on to login after a moment, unless the page was left first", async () => {
	session.mockResolvedValue(false);
	verify.mockResolvedValue();
	open();
	await screen.findByText(/Your email is verified/);
	await waitFor(
		() => expect(navigate).toHaveBeenCalledWith("/login?verified=1"),
		{ timeout: 3000 },
	);
	cleanup();
	navigate.mockReset();

	const left = open();
	await screen.findByText(/Your email is verified/);
	left.unmount();
	await new Promise((r) => setTimeout(r, 1800));
	expect(navigate).not.toHaveBeenCalled();
});
