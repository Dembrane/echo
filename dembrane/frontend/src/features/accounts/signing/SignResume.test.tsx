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
import { offerDetail } from "../contract/fixtures.gen";
import { draftKey } from "./signingDraft";

// A reload in the middle of signing: the walk is back at the same field with what was
// typed, the signature is not kept, leaving with unsaved input asks first, and the events
// carry the document and the step, never what was typed. The API is stood in for; the
// PDF never arrives, which leaves the panel to work with.
const capture = vi.hoisted(() => vi.fn());
const me = vi.hoisted(() => ({
	data: {
		directus_user_id: "user-1",
		display_name: "Ada Lovelace",
		email: "ada@example.org",
		id: "app-1",
	},
}));
vi.mock("posthog-js", () => ({ default: { capture } }));
vi.mock("@/hooks/useV2Me", () => ({ useV2Me: () => me }));
vi.mock("../i18n", () => ({
	AccountsI18n: ({ children }: { children: React.ReactNode }) => children,
	useAccountsCatalog: () => true,
}));
vi.mock("../api/client", async (importOriginal) => {
	const real = await importOriginal<typeof import("../api/client")>();
	return {
		...real,
		call: async (name: string) =>
			name === "readDocument" ? { ...offerDetail, status: "viewed" } : {},
		fetchPdf: () => new Promise(() => {}),
	};
});

import { SignRoute } from "./SignRoute";

const ORG = "0199a1bd-0000-7000-8000-000000000001";
const SIGN = `/en-US/o/${ORG}/account/documents/${offerDetail.id}/sign`;

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
	window.matchMedia = ((query: string) => ({
		addEventListener: () => {},
		addListener: () => {},
		dispatchEvent: () => false,
		matches: false,
		media: query,
		onchange: null,
		removeEventListener: () => {},
		removeListener: () => {},
	})) as unknown as typeof window.matchMedia;
	window.scrollTo = () => {};
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
	Element.prototype.scrollIntoView = () => {};
});
beforeEach(() => {
	sessionStorage.clear();
	capture.mockReset();
});
afterEach(cleanup);

const open = () =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<QueryClientProvider
					client={
						new QueryClient({ defaultOptions: { queries: { retry: false } } })
					}
				>
					<MemoryRouter initialEntries={[SIGN]}>
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

const input = () => screen.getByTestId("sign-field-input") as HTMLInputElement;
const events = (name: string) =>
	capture.mock.calls.filter(([event]) => event === name).map(([, p]) => p);

describe("signing survives a reload", () => {
	it("comes back at the same field with what was typed, and sends only ids and steps", async () => {
		open();
		fireEvent.click(await screen.findByTestId("sign-start"));
		// The name, prefilled from the profile, is the first field.
		await waitFor(() => expect(input().value).toBe("Ada Lovelace"));
		fireEvent.click(screen.getByTestId("sign-next"));
		// Organisation, prefilled from billing; change it.
		fireEvent.change(input(), { target: { value: "Gemeente Testdorp" } });
		cleanup();

		// The reload.
		open();
		await waitFor(() => expect(input().value).toBe("Gemeente Testdorp"));
		expect(screen.queryByTestId("sign-start")).toBeNull();

		const stored = sessionStorage.getItem(draftKey(offerDetail.id)) ?? "";
		expect(stored).toContain("Gemeente Testdorp");
		expect(stored).not.toMatch(/png|base64|data:image/);

		expect(events("document_signing_started")).toEqual([
			{ document_id: offerDetail.id, document_kind: "offer" },
		]);
		expect(events("document_signing_step_viewed")).toContainEqual({
			document_id: offerDetail.id,
			document_kind: "offer",
			step_index: 1,
			step_kind: "text",
		});
		// Leaving the page mid-walk counts once, at the step it was on.
		expect(events("document_signing_abandoned")).toContainEqual({
			document_id: offerDetail.id,
			document_kind: "offer",
			step_index: 1,
		});
		// Nothing typed goes out with any event.
		expect(JSON.stringify(capture.mock.calls)).not.toMatch(
			/Gemeente Testdorp|Ada Lovelace|ada@example\.org/,
		);
	});

	it("another person signed in starts clean", async () => {
		sessionStorage.setItem(
			draftKey(offerDetail.id),
			JSON.stringify({
				current: offerDetail.fields[1]?.id,
				finishing: false,
				owner: "someone-else",
				sha256: offerDetail.sha256,
				values: { [offerDetail.fields[1]?.id ?? ""]: "Not yours" },
				visited: [],
			}),
		);
		open();
		expect(await screen.findByTestId("sign-start")).toBeTruthy();
		expect(sessionStorage.getItem(draftKey(offerDetail.id))).toBeNull();
	});

	it("asks before leaving only while something would be lost", async () => {
		const leave = () => {
			const e = new Event("beforeunload", { cancelable: true });
			window.dispatchEvent(e);
			return e.defaultPrevented;
		};
		open();
		fireEvent.click(await screen.findByTestId("sign-start"));
		await waitFor(() => expect(input().value).toBe("Ada Lovelace"));
		// Kept in session storage: a reload loses nothing, so no question.
		expect(leave()).toBe(false);
		cleanup();

		// With storage blocked, the same walk would be lost: ask first.
		const setItem = vi
			.spyOn(Storage.prototype, "setItem")
			.mockImplementation(() => {
				throw new Error("blocked");
			});
		try {
			open();
			fireEvent.click(await screen.findByTestId("sign-start"));
			await waitFor(() => expect(leave()).toBe(true));
		} finally {
			setItem.mockRestore();
		}
	});
});
