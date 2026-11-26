// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// The signer leaves the invitation to read the code in their mail and comes back. The page
// checks the session again on return; that check must not replace the page, or the step and
// the digits typed into it are gone. Everything but the session check is stood in for.
const auth = vi.hoisted(() => ({
	hasSession: vi.fn(),
	sendSignInCode: vi.fn(),
	signInWithCode: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
	AuthError: class extends Error {},
	hasSession: auth.hasSession,
	otherSessions: async () => ({ devices: [], held: false }),
	replaceOtherDevice: async () => {},
	requestPasswordReset: async () => {},
	resendVerificationEmail: async () => {},
	resetPassword: async () => {},
	sendSignInCode: auth.sendSignInCode,
	signIn: async () => {},
	signInWithCode: auth.signInWithCode,
	signOut: async () => {},
	verifyEmail: async () => {},
}));
vi.mock("@posthog/react", () => ({ usePostHog: () => undefined }));
vi.mock("@/hooks/useI18nNavigate", () => ({ useI18nNavigate: () => vi.fn() }));
vi.mock("@/hooks/useV2Me", () => ({ useV2Me: () => ({ data: undefined }) }));
vi.mock("../i18n", () => ({
	AccountsI18n: ({ children }: { children: React.ReactNode }) => children,
	useAccountsCatalog: () => true,
}));
vi.mock("./SignRoute", () => ({
	SignRoute: () => <div data-testid="sign-route" />,
}));
// The person the invitation names. By default someone the server knows; a test may swap in
// an address it does not, which the page cannot tell apart (the server answers the same).
const KNOWN = {
	email: "signer@example.org",
	first_name: "Sig",
	has_account: true,
	last_name: "Ner",
};
const fixture = vi.hoisted(() => ({
	signer: null as null | {
		email: string;
		first_name: string;
		has_account: boolean;
		last_name: string;
	},
}));
vi.mock("../api/client", () => ({
	AccountsApiError: class extends Error {
		status = 0;
	},
	call: async () => {
		const { has_account, ...signer } = fixture.signer ?? KNOWN;
		return {
			document: { reference: "DMB-1", title: "Offer (sample)" },
			has_account,
			inviter: { name: "Sam" },
			organisation: { name: "Acme Civic (sample)" },
			signer,
			status: "open",
		};
	},
}));

import { SignGate } from "./SignGate";

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
	vi.resetAllMocks();
	fixture.signer = null;
});

const hideThenShowTab = async () => {
	const state = vi.spyOn(document, "visibilityState", "get");
	state.mockReturnValue("hidden");
	await act(async () => {
		window.dispatchEvent(new Event("visibilitychange"));
	});
	state.mockReturnValue("visible");
	await act(async () => {
		window.dispatchEvent(new Event("visibilitychange"));
	});
	state.mockRestore();
};

const renderGate = () =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<QueryClientProvider client={new QueryClient()}>
					<MemoryRouter
						initialEntries={[
							"/o/org-1/account/documents/doc-1/sign?invite=tok",
						]}
					>
						<Routes>
							<Route
								path="/o/:organisationId/account/documents/:docId/sign"
								element={<SignGate />}
							/>
						</Routes>
					</MemoryRouter>
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);

describe("the invitation page", () => {
	it("keeps its step and the typed code when the tab loses and regains focus", async () => {
		auth.hasSession.mockResolvedValue(false);
		auth.sendSignInCode.mockResolvedValue(undefined);
		renderGate();

		fireEvent.click(await screen.findByTestId("invite-send-code"));
		const code = await screen.findByTestId("invite-code");
		expect(code).toBeTruthy();
		const digits = () =>
			Array.from(
				screen
					.getByTestId("invite-code")
					.closest("div")
					?.querySelectorAll("input") ?? [],
			);
		const typed = digits().filter((i) => i.type !== "hidden");
		fireEvent.change(typed[0] as HTMLInputElement, { target: { value: "1" } });
		fireEvent.change(typed[1] as HTMLInputElement, { target: { value: "2" } });
		fireEvent.change(typed[2] as HTMLInputElement, { target: { value: "3" } });

		// The session check on return takes a while; the page must stay while it runs.
		let finish: (v: boolean) => void = () => {};
		auth.hasSession.mockReturnValueOnce(
			new Promise<boolean>((resolve) => {
				finish = resolve;
			}),
		);
		const checks = auth.hasSession.mock.calls.length;
		await hideThenShowTab();
		await waitFor(() =>
			expect(auth.hasSession.mock.calls.length).toBeGreaterThan(checks),
		);

		expect(screen.queryByTestId("invite-page")).toBeTruthy();
		expect(screen.queryByTestId("invite-code")).toBeTruthy();
		expect(screen.queryByTestId("invite-send-code")).toBeNull();
		const kept = Array.from(
			screen
				.getByTestId("invite-code")
				.closest("div")
				?.querySelectorAll("input") ?? [],
		)
			.filter((i) => i.type !== "hidden")
			.map((i) => i.value)
			.join("");
		expect(kept).toBe("123");

		await act(async () => finish(false));
		expect(screen.queryByTestId("invite-code")).toBeTruthy();
		expect(screen.queryByTestId("invite-send-code")).toBeNull();
	});

	it("still shows the loading screen for the first session check", async () => {
		let finish: (v: boolean) => void = () => {};
		auth.hasSession.mockReturnValueOnce(
			new Promise<boolean>((resolve) => {
				finish = resolve;
			}),
		);
		renderGate();
		expect(screen.queryByTestId("invite-page")).toBeNull();
		await act(async () => finish(false));
		expect(await screen.findByTestId("invite-page")).toBeTruthy();
	});
});

// The server emails a code only to an address it knows, and says the same either way, so
// strangers cannot learn which addresses exist. The person waiting for a code that never
// comes is told what to do, in words that are the same for every address.
describe("the code step, when no code arrives", () => {
	const NO_CODE =
		"No code after a minute? Check your spam folder, or ask the person who shared this with you to add you.";

	const lineFor = async (signer: typeof KNOWN) => {
		fixture.signer = signer;
		auth.hasSession.mockResolvedValue(false);
		auth.sendSignInCode.mockResolvedValue(undefined);
		renderGate();
		fireEvent.click(await screen.findByTestId("invite-send-code"));
		await screen.findByTestId("invite-code");
		const text = screen.getByTestId("invite-no-code").textContent;
		cleanup();
		return text;
	};

	it("is not there before the code step", async () => {
		auth.hasSession.mockResolvedValue(false);
		renderGate();
		expect(await screen.findByTestId("invite-send-code")).toBeTruthy();
		expect(screen.queryByTestId("invite-no-code")).toBeNull();
	});

	it("says the same for an address the server knows and one it does not", async () => {
		const known = await lineFor(KNOWN);
		const unknown = await lineFor({
			email: "stranger@example.net",
			first_name: "Stran",
			has_account: false,
			last_name: "Ger",
		});
		expect(known).toBe(NO_CODE);
		expect(unknown).toBe(NO_CODE);
	});
});
