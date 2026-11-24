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
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { DemoStatusT } from "../contract/contract.gen";
import * as fx from "../contract/fixtures.gen";

// The demo's page tells a demo in an organisation the contact already works in from one
// with a new organisation of its own: where it lives, and what publishing sends.

let current: DemoStatusT = fx.demoDraft;
/** The code publishing answers with, as the API refuses it; null publishes. */
let refusal: string | null = null;

vi.mock("../api/client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../api/client")>();
	return {
		...actual,
		call: vi.fn(async (name: string) => {
			if (name === "demoStatus") return current;
			if (name === "publishDemo" && refusal)
				throw new actual.AccountsApiError(
					409,
					"The detail staff never read",
					{},
					{
						action: "none",
						code: refusal,
						detail: "The detail staff never read",
						params: {},
					},
				);
			throw new Error(`unexpected call ${name}`);
		}),
	};
});
vi.mock("../i18n", () => ({
	AccountsI18n: ({ children }: { children: React.ReactNode }) => children,
	useAccountsCatalog: () => true,
}));
vi.mock("@/hooks/useV2Me", () => ({
	useV2Me: () => ({ data: { email: "staff@dembrane.com", is_staff: true } }),
}));

const { DemoRoute } = await import("./DemoRoute");

beforeAll(() => {
	i18n.load("en-US", {});
	i18n.activate("en-US");
	window.matchMedia ??= ((query: string) => ({
		addEventListener: () => {},
		addListener: () => {},
		dispatchEvent: () => false,
		matches: false,
		media: query,
		onchange: null,
		removeEventListener: () => {},
		removeListener: () => {},
	})) as unknown as typeof window.matchMedia;
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

const open = (demo: DemoStatusT) => {
	current = demo;
	return render(
		<I18nProvider i18n={i18n}>
			<MantineProvider env="test">
				<QueryClientProvider
					client={
						new QueryClient({ defaultOptions: { queries: { retry: false } } })
					}
				>
					<MemoryRouter
						initialEntries={[`/en-US/admin/accounts/demos/${demo.id}`]}
					>
						<Routes>
							<Route
								path="/:language/admin/accounts/demos/:demoId"
								element={<DemoRoute />}
							/>
						</Routes>
					</MemoryRouter>
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);
};

const inOrganisation = fx.demoDraftInOrganisation;
const organisation = inOrganisation.existing_organisation as {
	id: string;
	name: string;
};

it("says which organisation a demo placed there lives in, as plain text", async () => {
	open({ ...inOrganisation, sign_in: true });
	await screen.findByTestId("demo-draft");
	const line = screen.getByTestId("demo-existing-organisation");
	expect(line.textContent).toBe(`A workspace in ${organisation.name}.`);
	expect(line.querySelector("a")).toBeNull();
	expect(screen.getByText("Email them the demo")).toBeTruthy();
	expect(
		screen.getByText(
			(_, el) =>
				el?.tagName === "P" &&
				el.textContent ===
					`Publishing adds ${inOrganisation.contact_email} to the workspace and emails them the link.`,
		),
	).toBeTruthy();
	expect(document.body.textContent).not.toContain("sign-in invitation");
	// The account link stays, the one way to the organisation's card.
	expect(
		screen.getByText("The account").closest("a")?.getAttribute("href"),
	).toBe(`/en-US/admin/accounts/${inOrganisation.org_id}`);
});

it("says nobody is added when the email is off", async () => {
	open({ ...inOrganisation, sign_in: false });
	await screen.findByTestId("demo-draft");
	expect(
		screen.getByText(
			"Publishing makes the demo live. No email goes out and they are not added.",
		),
	).toBeTruthy();
});

it("says the contact has the email once a demo in their organisation is published", async () => {
	open(fx.demoPublishedInOrganisation);
	const notice = await screen.findByTestId("demo-published");
	expect(notice.textContent).toBe(
		`Published. The link was emailed to ${inOrganisation.contact_email}.`,
	);
});

it("shows a demo with a new organisation of its own as before", async () => {
	open(fx.demoDraft);
	await screen.findByTestId("demo-draft");
	expect(screen.queryByTestId("demo-existing-organisation")).toBeNull();
	expect(screen.getByText("Send the sign-in invitation")).toBeTruthy();
	expect(
		screen.getByText("The draft is ready. Check it, then publish."),
	).toBeTruthy();
});

// Publishing with the email on checks again that the contact is in the organisation and
// that it still exists; a refusal says why, and nothing on the page moves.
for (const [code, sentence] of [
	[
		"demo.contact_not_in_organisation",
		"They are no longer in this organisation, so the demo was not published. Add them back, or publish with the email off.",
	],
	[
		"demo.organisation_deleted",
		"The organisation for this demo was deleted, so nothing was done. Restore it and try again, or publish with the email off.",
	],
] as const) {
	it(`says why publishing was refused: ${code}`, async () => {
		refusal = code;
		try {
			open({ ...inOrganisation, sign_in: true });
			await screen.findByTestId("demo-draft");
			fireEvent.click(screen.getByTestId("demo-publish"));
			await waitFor(() => expect(screen.getByText(sentence)).toBeTruthy());
			expect(document.body.textContent).not.toContain("Something went wrong");
			expect(document.body.textContent).not.toContain(
				"The detail staff never read",
			);
			expect(
				screen.getByTestId("demo-screen").getAttribute("data-status"),
			).toBe("draft");
			expect(
				(screen.getByTestId("demo-publish-sign-in") as HTMLInputElement)
					.checked,
			).toBe(true);
		} finally {
			refusal = null;
		}
	});
}
