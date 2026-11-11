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
vi.mock("../api/client", () => ({
	AccountsApiError: class extends Error {
		status = 0;
	},
	call: async () => ({
		document: { reference: "DMB-1", title: "Offer (sample)" },
		has_account: true,
		inviter: { name: "Sam" },
		organisation: { name: "Acme Civic (sample)" },
		signer: {
			email: "signer@example.org",
			first_name: "Sig",
			last_name: "Ner",
		},
		status: "open",
	}),
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
