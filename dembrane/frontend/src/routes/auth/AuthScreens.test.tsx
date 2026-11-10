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
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route as Path, Routes } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { TransitionCurtainProvider } from "@/components/layout/TransitionCurtainProvider";
import { useV2Me } from "@/hooks/useV2Me";
import { CheckYourEmailRoute } from "./CheckYourEmail";
import { LoginRoute } from "./Login";
import { RegisterRoute } from "./Register";
import { RequestPasswordResetRoute } from "./RequestPasswordReset";

vi.mock("@posthog/react", () => ({ usePostHog: () => null }));

const { tracked } = vi.hoisted(() => ({
	tracked: [] as { event: string; props: unknown }[],
}));
vi.mock("@/lib/analytics/events", async (original) => ({
	...(await original<typeof import("@/lib/analytics/events")>()),
	track: (event: string, props?: unknown) => tracked.push({ event, props }),
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
		} as unknown as typeof ResizeObserver;
	}
	globalThis.scrollTo = globalThis.scrollTo ?? (() => {});
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.useRealTimers();
	tracked.length = 0;
});

const events = (name: string) =>
	tracked.filter((e) => e.event === name).map((e) => e.props);

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

it("a server failure says what to do instead of a bare 'Something went wrong'", async () => {
	stubFetch((url) =>
		url.endsWith("/auth/sign-in/email") ? json(500, {}) : undefined,
	);
	wrap(<LoginRoute />, "/login");
	logIn("someone@example.com");
	await screen.findByText(
		"Something went wrong. Try again, and contact support if it keeps happening.",
	);
	expect(screen.queryByText("Something went wrong")).toBeNull();
	expect(events("user_login_failed")).toEqual([
		{ cause: "server", error_code: "HTTP_500", http_status: 500 },
	]);
});

it("a wrong password is counted as wrong credentials, with no typed value in the event", async () => {
	stubFetch((url) =>
		url.endsWith("/auth/sign-in/email")
			? json(401, { code: "INVALID_EMAIL_OR_PASSWORD" })
			: undefined,
	);
	wrap(<LoginRoute />, "/login");
	logIn("someone@example.com");
	await screen.findByText(/The email or password is not right/);
	expect(events("user_login_failed")).toEqual([
		{
			cause: "wrong_credentials",
			error_code: "INVALID_EMAIL_OR_PASSWORD",
			http_status: 401,
		},
	]);
	expect(JSON.stringify(tracked)).not.toMatch(
		/someone@example\.com|wrong-password/,
	);
});

it("an unreachable server says to check the connection", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new TypeError("Failed to fetch");
		}),
	);
	wrap(<LoginRoute />, "/login");
	logIn("someone@example.com");
	await screen.findByText(
		"We could not reach dembrane. Check your internet connection and try again.",
	);
	expect(events("user_login_failed")).toEqual([
		{ cause: "network", error_code: null, http_status: null },
	]);
});

it("a login blocked before dembrane says so and offers the emailed code", async () => {
	stubFetch((url) =>
		url.endsWith("/auth/sign-in/email")
			? new Response("<html>Forbidden</html>", { status: 403 })
			: undefined,
	);
	wrap(<LoginRoute />, "/login");
	logIn("blocked@example.com");
	const notice = await screen.findByTestId("auth-login-blocked");
	expect(notice.textContent).toContain("stopped before it reached dembrane");
	expect(notice.textContent).toContain("support@dembrane.com");
	expect(events("user_login_failed")).toEqual([
		{ cause: "blocked", error_code: "HTTP_403", http_status: 403 },
	]);
	expect(events("login_blocked_shown")).toHaveLength(1);
	fireEvent.click(screen.getByTestId("auth-login-blocked-use-code"));
	const email = await screen.findByTestId("auth-login-code-email-input");
	expect((email as HTMLInputElement).value).toBe("blocked@example.com");
	expect(screen.queryByTestId("auth-login-blocked")).toBeNull();
});

it("a rate-limited login counts down from the server's wait and keeps Log in off until then", async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	stubFetch((url) =>
		url.endsWith("/auth/sign-in/email")
			? new Response(JSON.stringify({ message: "Too many requests." }), {
					headers: { "X-Retry-After": "3" },
					status: 429,
				})
			: undefined,
	);
	wrap(<LoginRoute />, "/login");
	logIn("someone@example.com");
	const notice = await screen.findByTestId("auth-login-rate-limit");
	expect(notice.textContent).not.toMatch(/code/i);
	expect(screen.getByTestId("auth-login-rate-limit-wait").textContent).toBe(
		"You can try again in 0:03.",
	);
	const button = screen.getByTestId(
		"auth-login-submit-button",
	) as HTMLButtonElement;
	expect(button.disabled).toBe(true);
	expect(events("login_rate_limit_shown")).toEqual([{ retry_after_s: 3 }]);
	expect(events("user_login_failed")).toEqual([
		{ cause: "rate_limited", error_code: "HTTP_429", http_status: 429 },
	]);

	await act(() => vi.advanceTimersByTimeAsync(1000));
	expect(screen.getByTestId("auth-login-rate-limit-wait").textContent).toBe(
		"You can try again in 0:02.",
	);
	// One tick a second: each is scheduled after the previous one rendered.
	for (let i = 0; i < 2; i++)
		await act(() => vi.advanceTimersByTimeAsync(1000));
	expect(screen.getByTestId("auth-login-rate-limit-wait").textContent).toBe(
		"You can try again now.",
	);
	expect(button.disabled).toBe(false);
});

it("a rate limit without a wait from the server falls back to a fixed one", async () => {
	stubFetch((url) =>
		url.endsWith("/auth/sign-in/email") ? json(429, {}) : undefined,
	);
	wrap(<LoginRoute />, "/login");
	logIn("someone@example.com");
	await screen.findByTestId("auth-login-rate-limit");
	expect(screen.getByTestId("auth-login-rate-limit-wait").textContent).toBe(
		"You can try again in 0:30.",
	);
	expect(events("login_rate_limit_shown")).toEqual([{ retry_after_s: 30 }]);
});

it("the code sign-in reads the platform limiter's retry_after_seconds and keeps its code wording", async () => {
	stubFetch((url) =>
		url.endsWith("/auth/email-otp/send-verification-otp")
			? json(429, {
					action: "wait",
					code: "rate_limit.exceeded",
					detail: "Too many requests. Try again later.",
					params: { retry_after_seconds: 42 },
				})
			: undefined,
	);
	wrap(<LoginRoute />, "/login");
	fireEvent.click(screen.getByTestId("auth-login-code-mode"));
	fireEvent.change(screen.getByTestId("auth-login-code-email-input"), {
		target: { value: "code@example.com" },
	});
	fireEvent.click(screen.getByTestId("auth-login-code-send"));
	const notice = await screen.findByTestId("auth-login-rate-limit");
	expect(notice.textContent).toContain("request a new code");
	expect(screen.getByTestId("auth-login-rate-limit-wait").textContent).toBe(
		"You can try again in 0:42.",
	);
	expect(
		(screen.getByTestId("auth-login-code-send") as HTMLButtonElement).disabled,
	).toBe(true);
});

it("a failure after a successful sign-in is not a failed login: the person is told they are in and can carry on", async () => {
	let devicesUp = false;
	stubFetch((url) => {
		if (url.endsWith("/auth/sign-in/email")) return json(200, {});
		if (url.endsWith("/auth/other-sessions"))
			return devicesUp
				? json(200, { devices: [], held: false })
				: json(500, {});
		if (url.endsWith("/v2/me"))
			return json(200, { onboarding_completed: false });
		return undefined;
	});
	wrap(
		<Routes>
			<Path path="/login" element={<LoginRoute />} />
			<Path path="/:language/onboarding" element={<p>onboarding</p>} />
		</Routes>,
		"/login",
	);
	logIn("signed-in@example.com");
	await screen.findByTestId("auth-login-signed-in-retry");
	expect(screen.queryByText(/Something went wrong/)).toBeNull();
	expect(events("user_login_failed")).toHaveLength(0);
	devicesUp = true;
	fireEvent.click(screen.getByTestId("auth-login-signed-in-continue"));
	await screen.findByText("onboarding", {}, { timeout: 5000 });
	expect(events("user_logged_in")).toHaveLength(1);
}, 15_000);

it("offers 'Forgot your password?' before anything has gone wrong", () => {
	wrap(<LoginRoute />, "/login");
	expect(screen.getByTestId("auth-login-forgot-password-link")).toBeTruthy();
});

it("the login fields carry the sign-in hints for password managers", () => {
	wrap(<LoginRoute />, "/login");
	expect(
		screen.getByTestId("auth-login-email-input").getAttribute("autocomplete"),
	).toBe("username");
	expect(
		screen
			.getByTestId("auth-login-password-input")
			.getAttribute("autocomplete"),
	).toBe("current-password");
});

it("a locked address from an invite or /register keeps the password manager out", () => {
	wrap(<LoginRoute />, "/login?email=new%40example.com");
	const email = screen.getByTestId("auth-login-email-input");
	expect(email.getAttribute("autocomplete")).toBe("off");
	expect(email.hasAttribute("readonly")).toBe(true);
	expect(
		screen
			.getByTestId("auth-login-password-input")
			.getAttribute("autocomplete"),
	).toBe("new-password");
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

const fillDetails = () => {
	fireEvent.change(screen.getByTestId("auth-register-first-name-input"), {
		target: { value: "Reg" },
	});
	fireEvent.change(screen.getByTestId("auth-register-email-input"), {
		target: { value: "reg@example.com" },
	});
};

it("submitting an empty register form names what is missing", async () => {
	const calls = stubFetch(() => undefined);
	wrap(<RegisterRoute />, "/register");
	const button = screen.getByTestId("auth-register-continue-button");
	expect((button as HTMLButtonElement).disabled).toBe(false);
	fireEvent.click(button);
	await screen.findByText("Enter your first name");
	expect(screen.getByText("Enter your email")).toBeTruthy();
	expect(screen.getByText("Accept the terms to continue")).toBeTruthy();
	expect(screen.queryByTestId("auth-register-password-input")).toBeNull();
	expect(calls).toHaveLength(0);
});

it("unticked terms show the terms error and stay on the first step", async () => {
	wrap(<RegisterRoute />, "/register");
	fillDetails();
	fireEvent.click(screen.getByTestId("auth-register-continue-button"));
	await screen.findByText("Accept the terms to continue");
	expect(screen.queryByText("Enter your email")).toBeNull();
	expect(screen.queryByTestId("auth-register-password-input")).toBeNull();
	fireEvent.click(screen.getByTestId("auth-register-terms-checkbox"));
	await waitFor(() =>
		expect(screen.queryByText("Accept the terms to continue")).toBeNull(),
	);
});

it("a named field error updates as the field is fixed", async () => {
	wrap(<RegisterRoute />, "/register");
	fireEvent.click(screen.getByTestId("auth-register-continue-button"));
	await screen.findByText("Enter your first name");
	fireEvent.change(screen.getByTestId("auth-register-first-name-input"), {
		target: { value: "Reg" },
	});
	fireEvent.change(screen.getByTestId("auth-register-email-input"), {
		target: { value: "reg" },
	});
	await screen.findByText("Enter a valid email address");
	expect(screen.queryByText("Enter your first name")).toBeNull();
	fireEvent.change(screen.getByTestId("auth-register-email-input"), {
		target: { value: "reg@example.com" },
	});
	await waitFor(() =>
		expect(screen.queryByText("Enter a valid email address")).toBeNull(),
	);
});

it("a bad email address is named on the field", async () => {
	wrap(<RegisterRoute />, "/register");
	fillDetails();
	fireEvent.change(screen.getByTestId("auth-register-email-input"), {
		target: { value: "reg" },
	});
	fireEvent.click(screen.getByTestId("auth-register-terms-checkbox"));
	fireEvent.click(screen.getByTestId("auth-register-continue-button"));
	await screen.findByText("Enter a valid email address");
});

it("Enter moves through the register steps without throwing", async () => {
	const calls = stubFetch((url) =>
		url.endsWith("/v2/auth/register")
			? new Response(null, { status: 204 })
			: undefined,
	);
	wrap(<RegisterRoute />, "/register");
	fillDetails();
	fireEvent.click(screen.getByTestId("auth-register-terms-checkbox"));
	fireEvent.submit(screen.getByTestId("auth-register-first-name-input"));
	const pw = await screen.findByTestId("auth-register-password-input");

	// Enter on an empty password step names the problem and sends nothing.
	fireEvent.submit(pw);
	await screen.findByText("Enter a password");
	expect(calls).toHaveLength(0);

	fireEvent.change(pw, { target: { value: "Abcdefgh1!xyz" } });
	fireEvent.change(screen.getByTestId("auth-register-confirm-password-input"), {
		target: { value: "Abcdefgh1!xyz" },
	});
	fireEvent.submit(pw);
	await screen.findByTestId("auth-register-verify-step");
	expect(calls.filter((c) => c.url.endsWith("/v2/auth/register"))).toHaveLength(
		1,
	);
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

it("an address the server would drop is refused on the form", async () => {
	const calls = stubFetch(() => undefined);
	wrap(<RegisterRoute />, "/register");
	fillDetails();
	// Accepted by the old includes("@") check, silently dropped by the server.
	fireEvent.change(screen.getByTestId("auth-register-email-input"), {
		target: { value: "reg@example" },
	});
	fireEvent.click(screen.getByTestId("auth-register-terms-checkbox"));
	fireEvent.click(screen.getByTestId("auth-register-continue-button"));
	await screen.findByText("Enter a valid email address");
	expect(screen.queryByTestId("auth-register-password-input")).toBeNull();
	expect(calls).toHaveLength(0);
});

it("the register fields carry the hints a password manager needs", async () => {
	wrap(<RegisterRoute />, "/register");
	const hint = (id: string) =>
		screen.getByTestId(id).getAttribute("autocomplete");
	expect(hint("auth-register-first-name-input")).toBe("given-name");
	expect(hint("auth-register-last-name-input")).toBe("family-name");
	expect(hint("auth-register-email-input")).toBe("username");
	fillDetails();
	fireEvent.click(screen.getByTestId("auth-register-terms-checkbox"));
	fireEvent.click(screen.getByTestId("auth-register-continue-button"));
	await screen.findByTestId("auth-register-password-input");
	expect(hint("auth-register-password-input")).toBe("new-password");
	expect(hint("auth-register-confirm-password-input")).toBe("new-password");
	// The address travels with the password step for the password manager.
	const username = document.querySelector(
		'input[autocomplete="username"]',
	) as HTMLInputElement;
	expect(username.value).toBe("reg@example.com");
});

it("'Wrong address? Change email' goes back to the email field and keeps the other answers", async () => {
	const calls = stubFetch((url) =>
		url.endsWith("/v2/auth/register")
			? new Response(null, { status: 204 })
			: undefined,
	);
	wrap(<RegisterRoute />, "/register");
	fillDetails();
	fireEvent.change(screen.getByTestId("auth-register-last-name-input"), {
		target: { value: "Ister" },
	});
	fireEvent.click(screen.getByTestId("auth-register-terms-checkbox"));
	fireEvent.click(screen.getByTestId("auth-register-continue-button"));
	const pw = await screen.findByTestId("auth-register-password-input");
	fireEvent.change(pw, { target: { value: "Abcdefgh1!xyz" } });
	fireEvent.change(screen.getByTestId("auth-register-confirm-password-input"), {
		target: { value: "Abcdefgh1!xyz" },
	});
	fireEvent.click(screen.getByTestId("auth-register-submit-button"));
	await screen.findByTestId("auth-register-verify-step");

	fireEvent.click(screen.getByTestId("auth-register-change-email"));
	const email = (await screen.findByTestId(
		"auth-register-email-input",
	)) as HTMLInputElement;
	expect(document.activeElement).toBe(email);
	expect(email.value).toBe("reg@example.com");
	expect(
		(screen.getByTestId("auth-register-first-name-input") as HTMLInputElement)
			.value,
	).toBe("Reg");
	expect(
		(screen.getByTestId("auth-register-last-name-input") as HTMLInputElement)
			.value,
	).toBe("Ister");
	expect(
		(screen.getByTestId("auth-register-terms-checkbox") as HTMLInputElement)
			.checked,
	).toBe(true);

	fireEvent.change(email, { target: { value: "fixed@example.com" } });
	fireEvent.click(screen.getByTestId("auth-register-continue-button"));
	const again = (await screen.findByTestId(
		"auth-register-password-input",
	)) as HTMLInputElement;
	expect(again.value).toBe("Abcdefgh1!xyz");
	fireEvent.click(screen.getByTestId("auth-register-submit-button"));
	await screen.findByTestId("auth-register-verify-step");
	const sent = calls.filter((c) => c.url.endsWith("/v2/auth/register"));
	expect(sent.map((c) => (c.body as { email: string }).email)).toEqual([
		"reg@example.com",
		"fixed@example.com",
	]);
	expect(screen.getByTestId("auth-register-verify-step").textContent).toContain(
		"fixed@example.com",
	);
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

const activeDevices = [
	{
		browser: "Chrome",
		id: "laptop-session",
		lastActiveAt: "2026-10-14T19:00:00.000Z",
		platform: "Windows",
	},
	{
		browser: "Safari",
		id: "phone-session",
		lastActiveAt: "2026-10-14T18:00:00.000Z",
		platform: "iPhone",
	},
];

it("signing out a selected device lands on onboarding with the fresh /v2/me, not the 401 from the held sign-in", async () => {
	let held = true;
	const calls = stubFetch((url) => {
		if (url.endsWith("/auth/sign-in/email")) return json(200, {});
		if (url.endsWith("/auth/other-sessions"))
			return json(200, { devices: activeDevices, held, since: null });
		if (url.endsWith("/auth/other-sessions/replace-device")) {
			held = false;
			return json(200, {});
		}
		if (url.endsWith("/v2/me"))
			return held
				? json(401, {})
				: json(200, { has_pending_invites: true, onboarding_completed: false });
		return undefined;
	});
	// App.tsx keeps a /v2/me query mounted on every page, the login page included.
	const AlwaysOn = () => {
		useV2Me();
		return null;
	};
	const Onboarding = () => {
		const { data } = useV2Me();
		return <p>{data?.has_pending_invites ? "invited" : "not invited"}</p>;
	};
	wrap(
		<>
			<AlwaysOn />
			<Routes>
				<Path path="/login" element={<LoginRoute />} />
				<Path path="/:language/onboarding" element={<Onboarding />} />
			</Routes>
		</>,
		"/login",
	);
	logIn("invitee@example.com");
	const confirm = await screen.findByTestId(
		"auth-login-elsewhere-confirm",
		{},
		{ timeout: 5000 },
	);
	expect((confirm as HTMLButtonElement).disabled).toBe(true);
	fireEvent.click(confirm);
	expect(
		calls.some((call) =>
			call.url.endsWith("/auth/other-sessions/replace-device"),
		),
	).toBe(false);
	fireEvent.click(screen.getByRole("radio", { name: /Chrome on Windows/ }));
	fireEvent.click(confirm);
	await screen.findByText("invited", {}, { timeout: 5000 });
	expect(
		calls.find((call) =>
			call.url.endsWith("/auth/other-sessions/replace-device"),
		)?.body,
	).toEqual({ sessionId: "laptop-session" });
}, 15_000);

it("cancelling a third-device sign-in never asks to replace another device", async () => {
	const calls = stubFetch((url) => {
		if (url.endsWith("/auth/sign-in/email")) return json(200, {});
		if (url.endsWith("/auth/other-sessions"))
			return json(200, { devices: activeDevices, held: true });
		if (url.endsWith("/auth/sign-out")) return json(200, {});
		return undefined;
	});
	wrap(<LoginRoute />, "/login");
	logIn("host@example.com");
	fireEvent.click(
		await screen.findByTestId(
			"auth-login-elsewhere-cancel",
			{},
			{ timeout: 5000 },
		),
	);
	await waitFor(() =>
		expect(calls.some((call) => call.url.endsWith("/auth/sign-out"))).toBe(
			true,
		),
	);
	expect(
		calls.filter((call) => call.url.includes("/other-sessions/replace")),
	).toHaveLength(0);
	expect(screen.queryByTestId("auth-login-elsewhere")).toBeNull();
}, 15_000);

it("a stale device choice refreshes the list and requires another explicit selection", async () => {
	let stale = false;
	stubFetch((url) => {
		if (url.endsWith("/auth/sign-in/email")) return json(200, {});
		if (url.endsWith("/auth/other-sessions"))
			return json(200, {
				devices: stale
					? [
							{ ...activeDevices[0], id: "new-laptop-session" },
							activeDevices[1],
						]
					: activeDevices,
				held: true,
			});
		if (url.endsWith("/auth/other-sessions/replace-device")) {
			stale = true;
			return json(409, {
				message: "This device is no longer available. Choose again.",
			});
		}
		return undefined;
	});
	wrap(<LoginRoute />, "/login");
	logIn("host@example.com");
	const confirm = await screen.findByTestId(
		"auth-login-elsewhere-confirm",
		{},
		{ timeout: 5000 },
	);
	fireEvent.click(screen.getByRole("radio", { name: /Chrome on Windows/ }));
	fireEvent.click(confirm);
	await screen.findByText(
		"Your active devices changed. Choose a device again.",
	);
	expect((confirm as HTMLButtonElement).disabled).toBe(true);
	expect(screen.getByTestId("auth-login-elsewhere")).toBeTruthy();
}, 15_000);
