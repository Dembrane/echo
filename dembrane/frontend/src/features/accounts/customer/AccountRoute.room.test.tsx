// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AccountPageT, TaskT } from "../contract/contract.gen";
import * as fx from "../contract/fixtures.gen";

// A room member's view of the account (AccountPage.access "room"): the offer and the DPA,
// the tasks on them read only, no invoices, billing details or questions, and no download
// while may_download is false. dashboard-plan.md, unit 9.

const ORG = fx.accountPage.organisation.id;
const offer = fx.accountPage.documents.find((d) => d.kind === "offer");
const dpa = fx.accountPage.documents.find((d) => d.kind === "dpa");
const answered: TaskT = {
	...fx.signTask,
	code: null,
	id: "0199a1b9-0000-7000-8000-0000000000aa",
	kind: "upload",
	params: null,
	response_file_name: "collegebesluit.pdf",
	response_text: "Besluit van het college",
	review_note: "Graag de getekende versie",
	status: "changes_requested",
	title: "Stuur ons het collegebesluit",
};
const roomPage: AccountPageT = {
	...fx.accountPage,
	access: "room",
	billing: Object.fromEntries(
		Object.keys(fx.accountPage.billing).map((k) => [k, null]),
	) as AccountPageT["billing"],
	documents: [
		{ ...(offer as AccountPageT["documents"][number]), may_download: false },
		{ ...(dpa as AccountPageT["documents"][number]), may_download: true },
	],
	needs_form_reference: null,
	tasks: [fx.whoSignsTask, fx.signTask, answered],
	tickets: [],
};

vi.mock("../api/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("../api/client")>()),
	call: vi.fn(async (name: string) => {
		if (name === "accountPage") return roomPage;
		if (name === "roomPage") return fx.roomPageAsColleague;
		throw new Error(`unexpected call ${name}`);
	}),
}));
vi.mock("../i18n", () => ({
	AccountsI18n: ({ children }: { children: React.ReactNode }) => children,
	useAccountsCatalog: () => true,
}));
vi.mock("@/hooks/useV2Me", () => ({
	useV2Me: () => ({ data: { email: "sam@example-town.example" } }),
}));
vi.mock("@/hooks/useI18nNavigate", () => ({ useI18nNavigate: () => vi.fn() }));
vi.mock("@posthog/react", () => ({ usePostHog: () => undefined }));

const { AccountDocumentsRoute, AccountTasksRoute } = await import(
	"./AccountRoute"
);

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
	Element.prototype.scrollIntoView ??= () => {};
});
afterEach(cleanup);

const open = (page: "tasks" | "documents") =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider env="test">
				<QueryClientProvider
					client={
						new QueryClient({ defaultOptions: { queries: { retry: false } } })
					}
				>
					<MemoryRouter initialEntries={[`/en-US/o/${ORG}/${page}`]}>
						<Routes>
							<Route
								path="/:language/o/:organisationId/tasks"
								element={<AccountTasksRoute />}
							/>
							<Route
								path="/:language/o/:organisationId/documents"
								element={<AccountDocumentsRoute />}
							/>
						</Routes>
					</MemoryRouter>
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);

describe("Tasks, as a room member", () => {
	it("lists the tasks on the offer and the DPA with their answers, read only", async () => {
		open("tasks");
		const list = await screen.findByTestId("room-tasks");
		expect(list.textContent).toContain("Besluit van het college");
		expect(list.textContent).toContain("Graag de getekende versie");
		expect(document.querySelector('[data-testid^="action-"]')).toBeNull();
		expect(document.querySelector('input[type="file"]')).toBeNull();
	});

	it("shows no billing details form", async () => {
		open("tasks");
		await screen.findByTestId("room-tasks");
		expect(document.querySelector('[data-testid^="billing-"]')).toBeNull();
	});
});

describe("Documents, as a room member", () => {
	it("reads the offer without a download while it may not be saved", async () => {
		open("documents");
		const offerRow = await screen.findByTestId("doc-offer");
		expect(offerRow.querySelector('[data-testid="doc-read"]')).not.toBeNull();
		expect(offerRow.querySelector('[data-testid="doc-pdf"]')).toBeNull();
		expect(offerRow.querySelector('[data-testid="doc-sign"]')).toBeNull();
		expect(screen.queryByTestId("doc-invoice")).toBeNull();
	});
});
