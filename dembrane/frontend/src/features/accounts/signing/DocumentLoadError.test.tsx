// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

// The signing screen when the document does not open: signed out, signed in under an
// address it is not for (403 for a member without the right, 404 for anyone outside the
// organisation, as the API answers), or the connection. The document request is stood in
// for; everything else is the real screen.
const api = vi.hoisted(() => ({ status: 0 }));
const logout = vi.hoisted(() => vi.fn());
const me = vi.hoisted(() => ({
	data: { email: "someone@else.example" } as { email: string } | undefined,
}));

vi.mock("../api/client", async (importOriginal) => {
	const real = await importOriginal<typeof import("../api/client")>();
	return {
		...real,
		call: async () => {
			throw new real.AccountsApiError(api.status, "refused");
		},
	};
});
vi.mock("@/hooks/useV2Me", () => ({ useV2Me: () => me }));
vi.mock("@/components/auth/hooks", () => ({
	useLogoutMutation: () => ({ isPending: false, mutate: logout }),
}));
vi.mock("../i18n", () => ({
	AccountsI18n: ({ children }: { children: React.ReactNode }) => children,
	useAccountsCatalog: () => true,
}));

import { loadFailure } from "./DocumentLoadError";
import { SignRoute } from "./SignRoute";
import { AccountsApiError } from "../api/client";

const ORG = "0199a1bd-0000-7000-8000-000000000001";
const DOC = "0199a1bd-0000-7000-8000-000000000002";
const SIGN = `/o/${ORG}/account/documents/${DOC}/sign`;

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
beforeEach(() => {
	logout.mockReset();
	me.data = { email: "someone@else.example" };
});
afterEach(cleanup);

const open = (status: number) => {
	api.status = status;
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<QueryClientProvider
					client={
						new QueryClient({ defaultOptions: { queries: { retry: false } } })
					}
				>
					<MemoryRouter initialEntries={[`/en-US${SIGN}`]}>
						<Routes>
							<Route
								path="/:language/o/:organisationId/account/documents/:docId/sign"
								element={<SignRoute />}
							/>
						</Routes>
					</MemoryRouter>
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);
};

describe("which way the document failed", () => {
	it("tells 401, 403 and 404 apart and puts the rest together", () => {
		expect(loadFailure(new AccountsApiError(401, ""))).toBe("signed_out");
		expect(loadFailure(new AccountsApiError(403, ""))).toBe("no_access");
		expect(loadFailure(new AccountsApiError(404, ""))).toBe("not_found");
		expect(loadFailure(new AccountsApiError(500, ""))).toBe("other");
		expect(loadFailure(new Error("offline"))).toBe("other");
	});
});

describe("the signing screen when the document does not open", () => {
	it("signed out: log in again, back to this document", async () => {
		open(401);
		const box = await screen.findByTestId("sign-error-signed-out");
		expect(box.textContent).toContain("You are signed out.");
		const link = screen.getByTestId("sign-log-in") as HTMLAnchorElement;
		expect(decodeURIComponent(link.getAttribute("href") ?? "")).toContain(
			`/login?next=${SIGN}`,
		);
	});

	it("no access: names the address signed in and switches to the one it was sent to", async () => {
		open(403);
		const box = await screen.findByTestId("sign-error-no-access");
		expect(box.textContent).toContain(
			"You are signed in as someone@else.example, and this document is not shared with that address.",
		);
		expect(box.textContent).toContain(
			"Log in with the email address the offer was sent to.",
		);
		fireEvent.click(screen.getByTestId("sign-switch-account"));
		expect(logout).toHaveBeenCalledWith({ doRedirect: true, next: SIGN });
	});

	it("not found: the same way out, without saying whether the document exists", async () => {
		open(404);
		const box = await screen.findByTestId("sign-error-not-found");
		expect(box.textContent).toContain(
			"We could not find this document for someone@else.example.",
		);
		expect(box.textContent).toContain(
			"Log in with the email address the offer was sent to.",
		);
		expect(box.textContent).not.toContain("not shared");
		fireEvent.click(screen.getByTestId("sign-switch-account"));
		expect(logout).toHaveBeenCalledWith({ doRedirect: true, next: SIGN });
	});

	it("without the profile yet, it still says what to do", async () => {
		me.data = undefined;
		open(403);
		const box = await screen.findByTestId("sign-error-no-access");
		expect(box.textContent).toContain(
			"This document is not shared with the address you use.",
		);
	});

	it("anything else: the connection, with Try again", async () => {
		open(500);
		expect(await screen.findByTestId("pdf-load-failed")).toBeTruthy();
		expect(screen.getByTestId("pdf-retry")).toBeTruthy();
		await waitFor(() =>
			expect(screen.queryByTestId("sign-switch-account")).toBeNull(),
		);
	});
});
