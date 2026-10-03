// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import {
	MutationCache,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { TransitionCurtainProvider } from "@/components/layout/TransitionCurtainProvider";
import { CheckYourEmailRoute } from "./CheckYourEmail";
import { LoginRoute } from "./Login";
import { RegisterRoute } from "./Register";
import { RequestPasswordResetRoute } from "./RequestPasswordReset";

vi.mock("@posthog/react", () => ({ usePostHog: () => null }));

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
		} as unknown as typeof ResizeObserver;
	}
	globalThis.scrollTo = globalThis.scrollTo ?? (() => {});
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

type Route = (url: string, body: unknown) => Response | undefined;

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		status,
	});

const stubFetch = (route: Route) => {
	const calls: { url: string; body: unknown }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const body = init?.body ? JSON.parse(String(init.body)) : undefined;
			calls.push({ body, url });
			return route(url, body) ?? json(404, {});
		}),
	);
	return calls;
};

// The rule of App.tsx's MutationCache: a failed mutation toasts unless it opts out.
const wrap = (ui: ReactNode, path: string) => {
	const toasts: unknown[] = [];
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
		mutationCache: new MutationCache({
			onError: (error, _v, _c, mutation) => {
				if (mutation.options.onError) return;
				if (mutation.meta?.errorToast === false) return;
				toasts.push(error);
			},
		}),
	});
	render(
		<QueryClientProvider client={client}>
			<I18nProvider i18n={i18n}>
				<MantineProvider>
					<TransitionCurtainProvider>
						<MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
					</TransitionCurtainProvider>
				</MantineProvider>
			</I18nProvider>
		</QueryClientProvider>,
	);
	return toasts;
};

const resendCalls = (calls: { url: string; body: unknown }[]) =>
	calls.filter((c) => c.url.endsWith("/auth/send-verification-email"));

const okResend: Route = (url) =>
	url.endsWith("/auth/send-verification-email")
		? json(200, { status: true })
		: undefined;

const logIn = (email: string) => {
	fireEvent.change(screen.getByTestId("auth-login-email-input"), {
		target: { value: email },
	});
	fireEvent.change(screen.getByTestId("auth-login-password-input"), {
		target: { value: "wrong-password" },
	});
	fireEvent.click(screen.getByTestId("auth-login-submit-button"));
};

it("a wrong password shows the inline alert and no generic toast", async () => {
	stubFetch((url) =>
		url.endsWith("/auth/sign-in/email")
			? json(401, { code: "INVALID_EMAIL_OR_PASSWORD" })
			: undefined,
	);
	const toasts = wrap(<LoginRoute />, "/login");
	logIn("someone@example.com");
	await screen.findByText(/The email or password is not right/);
	expect(toasts).toHaveLength(0);
});

it("a login failure without a known code shows the old generic message", async () => {
	stubFetch((url) =>
		url.endsWith("/auth/sign-in/email") ? json(500, {}) : undefined,
	);
	wrap(<LoginRoute />, "/login");
	logIn("someone@example.com");
	await screen.findByText("Something went wrong");
});

it("an unverified login offers to resend the verification email", async () => {
	const calls = stubFetch(
		(url, body) =>
			okResend(url, body) ??
			(url.endsWith("/auth/sign-in/email")
				? json(403, { code: "EMAIL_NOT_VERIFIED" })
				: undefined),
	);
	const toasts = wrap(<LoginRoute />, "/login");
	logIn("unverified@example.com");
	await screen.findByText(/Your email is not verified yet/);
	fireEvent.click(await screen.findByTestId("auth-resend-verification"));
	await screen.findByText(/We sent a new verification link/);
	expect(resendCalls(calls)).toHaveLength(1);
	expect(resendCalls(calls)[0]?.body).toMatchObject({
		callbackURL: expect.stringMatching(/\/verify-email$/),
		email: "unverified@example.com",
	});
	// Cooldown: no second send right away.
	expect(screen.getByTestId("auth-resend-verification")).toHaveProperty(
		"disabled",
		true,
	);
	expect(toasts).toHaveLength(0);
});

it("the register check-your-email step can resend the link", async () => {
	const calls = stubFetch(
		(url, body) =>
			okResend(url, body) ??
			(url.endsWith("/v2/auth/register")
				? new Response(null, { status: 204 })
				: undefined),
	);
	wrap(<RegisterRoute />, "/register");
	fireEvent.change(screen.getByTestId("auth-register-first-name-input"), {
		target: { value: "Reg" },
	});
	fireEvent.change(screen.getByTestId("auth-register-email-input"), {
		target: { value: "reg@example.com" },
	});
	fireEvent.click(screen.getByTestId("auth-register-terms-checkbox"));
	fireEvent.click(screen.getByText("Continue"));
	const pw = await screen.findByTestId("auth-register-password-input");
	fireEvent.change(pw, { target: { value: "Abcdefgh1!xyz" } });
	fireEvent.change(screen.getByTestId("auth-register-confirm-password-input"), {
		target: { value: "Abcdefgh1!xyz" },
	});
	fireEvent.click(screen.getByTestId("auth-register-submit-button"));
	await screen.findByTestId("auth-register-verify-step");
	fireEvent.click(screen.getByTestId("auth-resend-verification"));
	await screen.findByText(/We sent a new verification link/);
	expect(resendCalls(calls)[0]?.body).toMatchObject({
		email: "reg@example.com",
	});
});

it("a failed registration shows its notice without a second toast", async () => {
	stubFetch((url) =>
		url.endsWith("/v2/auth/register")
			? json(500, { detail: "boom" })
			: undefined,
	);
	const toasts = wrap(<RegisterRoute />, "/register");
	fireEvent.change(screen.getByTestId("auth-register-first-name-input"), {
		target: { value: "Reg" },
	});
	fireEvent.change(screen.getByTestId("auth-register-email-input"), {
		target: { value: "reg@example.com" },
	});
	fireEvent.click(screen.getByTestId("auth-register-terms-checkbox"));
	fireEvent.click(screen.getByText("Continue"));
	const pw = await screen.findByTestId("auth-register-password-input");
	fireEvent.change(pw, { target: { value: "Abcdefgh1!xyz" } });
	fireEvent.change(screen.getByTestId("auth-register-confirm-password-input"), {
		target: { value: "Abcdefgh1!xyz" },
	});
	fireEvent.click(screen.getByTestId("auth-register-submit-button"));
	await waitFor(() =>
		expect(document.querySelector("[data-error-code]")).not.toBeNull(),
	);
	expect(toasts).toHaveLength(0);
});

it("check-your-email can resend the link to the address it names", async () => {
	const calls = stubFetch(okResend);
	wrap(<CheckYourEmailRoute />, "/check-your-email?email=late%40example.com");
	fireEvent.click(await screen.findByTestId("auth-resend-verification"));
	await screen.findByText(/We sent a new verification link/);
	expect(resendCalls(calls)[0]?.body).toMatchObject({
		email: "late@example.com",
	});
});

it("a reset request confirms on the page instead of the verification screen", async () => {
	stubFetch((url) =>
		url.endsWith("/auth/request-password-reset")
			? json(200, { status: true })
			: undefined,
	);
	wrap(<RequestPasswordResetRoute />, "/request-password-reset");
	fireEvent.change(screen.getByTestId("auth-password-reset-email-input"), {
		target: { value: "reset@example.com" },
	});
	fireEvent.click(screen.getByTestId("auth-password-reset-submit-button"));
	await screen.findByTestId("auth-password-reset-sent");
	expect(screen.getByTestId("auth-password-reset-sent").textContent).toContain(
		"reset@example.com",
	);
});
