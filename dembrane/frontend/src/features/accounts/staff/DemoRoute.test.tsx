// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { DemoStatusT } from "../contract/contract.gen";
import * as fx from "../contract/fixtures.gen";

// The demo's page tells a demo in an organisation the contact already works in from one
// with a new organisation of its own: where it lives, and what publishing sends.

let current: DemoStatusT = fx.demoDraft;

vi.mock("../api/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("../api/client")>()),
	call: vi.fn(async (name: string) => {
		if (name === "demoStatus") return current;
		throw new Error(`unexpected call ${name}`);
	}),
}));
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

it("says which organisation a demo placed there lives in, with a link to its card", async () => {
	open({ ...inOrganisation, sign_in: true });
	await screen.findByTestId("demo-draft");
	const link = screen.getByTestId("demo-existing-organisation");
	expect(link.getAttribute("href")).toBe(
		`/en-US/admin/accounts/${organisation.id}`,
	);
	expect(link.closest("p")?.textContent).toBe(
		`In ${organisation.name}, as the workspace ${inOrganisation.organisation_name}.`,
	);
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
	// The account link stays.
	expect(screen.getByText("The account")).toBeTruthy();
});

it("says the contact has the email once a demo in their organisation is published", async () => {
	open(fx.demoPublishedInOrganisation);
	const notice = await screen.findByTestId("demo-published");
	expect(notice.textContent).toBe(
		`Published. ${inOrganisation.contact_email} has the email with the link to the demo.`,
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
