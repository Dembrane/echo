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
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import * as fx from "../contract/fixtures.gen";

// The new demo form asks who the contact is once their address is complete, and offers
// the organisations they already work in. Robin is in one, Jules in two with an earlier
// demo and an organisation of the same name, anyone else is new to dembrane.

const calls: { name: string; body: Record<string, unknown> }[] = [];
const navigate = vi.fn();

vi.mock("../api/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("../api/client")>()),
	call: vi.fn(async (name: string, options: { body?: unknown } = {}) => {
		const body = (options.body ?? {}) as Record<string, unknown>;
		calls.push({ body, name });
		if (name === "checkDemo") {
			if (body.contact_email === "robin@example-town.example")
				return fx.demoCheckCustomer;
			if (body.contact_email === "jules@example-water.example")
				return fx.demoCheckTwoOrganisations;
			if (body.contact_email === "sam@example-solo.example")
				return {
					...fx.demoCheckNewContact,
					contact: {
						has_account: true,
						name: "Sam Example",
						organisations: [],
					},
				};
			return fx.demoCheckNewContact;
		}
		if (name === "createDemo") return { ...fx.demoRunning };
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
vi.mock("@/hooks/useI18nNavigate", () => ({ useI18nNavigate: () => navigate }));

const { NewDemoRoute } = await import("./NewDemoRoute");

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
beforeEach(() => {
	calls.length = 0;
	navigate.mockReset();
});
afterEach(cleanup);

const open = () =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider env="test">
				<QueryClientProvider
					client={
						new QueryClient({ defaultOptions: { queries: { retry: false } } })
					}
				>
					<MemoryRouter initialEntries={["/en-US/admin/accounts/new-demo"]}>
						<Routes>
							<Route
								path="/:language/admin/accounts/new-demo"
								element={<NewDemoRoute />}
							/>
						</Routes>
					</MemoryRouter>
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);

const type = (field: string, value: string) =>
	fireEvent.change(screen.getByTestId(`demo-${field}`), { target: { value } });

const fillForm = (email: string) => {
	type("organisation_name", "Example Youth Council (sample)");
	type("website_url", "https://www.example-youth.example/");
	type("brief", "Young people on what keeps them here after school.");
	type("contact_name", "Robin Example");
	type("contact_email", email);
};

/** The check waits for typing to stop (400ms) before it asks. */
const LATER = { timeout: 2000 };

it("offers a known contact's organisation, chosen, and sends it with no offer", async () => {
	open();
	fillForm("robin@example-town.example");
	const choice = await screen.findByTestId("demo-destination", {}, LATER);
	const [existing, fresh] = choice.querySelectorAll<HTMLInputElement>(
		'input[type="radio"]',
	);
	expect(existing?.checked).toBe(true);
	expect(fresh?.checked).toBe(false);
	expect(choice.textContent).toContain("Example Town Council (sample)");
	expect(screen.getByTestId("demo-destination-intro").textContent).toBe(
		"In an organisation they already work in, the demo gets its own workspace, Example Youth Council (sample).",
	);
	expect(choice.textContent).toContain("A new organisation");
	// The address goes in the body, never the URL; the name goes with it.
	expect(calls.find((c) => c.name === "checkDemo")?.body).toEqual({
		contact_email: "robin@example-town.example",
		organisation_name: "Example Youth Council (sample)",
	});
	// No offer in an existing organisation, and the switch talks about the email.
	expect(screen.queryByTestId("demo-with-offer")).toBeNull();
	expect(screen.getByText("Email them when you publish")).toBeTruthy();

	fireEvent.click(screen.getByTestId("demo-submit"));
	await waitFor(() => expect(navigate).toHaveBeenCalled());
	const sent = calls.find((c) => c.name === "createDemo")?.body;
	expect(sent?.org_id).toBe(fx.demoCheckCustomer.contact?.organisations[0]?.id);
	expect(sent?.offer).toBeNull();
});

it("sends no org_id when staff choose a new organisation, and the offer comes back", async () => {
	open();
	fillForm("robin@example-town.example");
	const choice = await screen.findByTestId("demo-destination", {}, LATER);
	const radios = choice.querySelectorAll<HTMLInputElement>(
		'input[type="radio"]',
	);
	fireEvent.click(radios[radios.length - 1] as HTMLInputElement);
	expect(
		screen.getByText(
			(_, el) =>
				el?.tagName === "P" &&
				el.textContent ===
					"Example Youth Council (sample) becomes a prospect in Accounts, with robin@example-town.example as its admin.",
		),
	).toBeTruthy();
	expect(screen.getByTestId("demo-with-offer")).toBeTruthy();
	expect(screen.getByText("Let them sign in with an email code")).toBeTruthy();

	fireEvent.click(screen.getByTestId("demo-submit"));
	await waitFor(() => expect(navigate).toHaveBeenCalled());
	expect(calls.find((c) => c.name === "createDemo")?.body).not.toHaveProperty(
		"org_id",
	);
});

it("says an unknown contact is new to dembrane, with nothing to choose", async () => {
	open();
	fillForm("new@example-harbour.example");
	expect(
		await screen.findByText(
			"New to dembrane. The demo gets a new organisation.",
			{},
			LATER,
		),
	).toBeTruthy();
	expect(screen.queryByTestId("demo-destination")).toBeNull();
	expect(screen.getByTestId("demo-with-offer")).toBeTruthy();
});

it("says a contact with an account but no organisation gets a new one, with nothing to choose", async () => {
	open();
	fillForm("sam@example-solo.example");
	expect(
		await screen.findByText(
			"They have an account but no organisation yet. The demo gets a new organisation.",
			{},
			LATER,
		),
	).toBeTruthy();
	expect(screen.queryByTestId("demo-destination")).toBeNull();
	expect(screen.getByTestId("demo-with-offer")).toBeTruthy();
	expect(screen.getByText("Let them sign in with an email code")).toBeTruthy();
});

it("asks nothing while the address is half typed", async () => {
	open();
	type("contact_email", "robin@example");
	await new Promise((r) => setTimeout(r, 600));
	expect(calls.some((c) => c.name === "checkDemo")).toBe(false);
	expect(screen.queryByTestId("demo-destination")).toBeNull();
});

it("names an earlier demo and a same-named organisation, each with a link", async () => {
	open();
	type("organisation_name", "Stichting Vrije Proef");
	type("contact_email", "jules@example-water.example");
	const notice = await screen.findByTestId("demo-repeats", {}, LATER);
	expect(notice.textContent).toContain(
		"There is already a demo for jules@example-water.example: Example Water Board (sample).",
	);
	expect(notice.textContent).toContain(
		"An organisation named Stichting Vrije Proef already exists.",
	);
	const earlier = fx.demoCheckTwoOrganisations.demos[0];
	const named = fx.demoCheckTwoOrganisations.organisations_named[0];
	const links = [...notice.querySelectorAll("a")].map((a) => [
		a.textContent,
		a.getAttribute("href"),
	]);
	expect(links).toEqual([
		["Open it", `/en-US/admin/accounts/demos/${earlier?.id}`],
		["Open the account", `/en-US/admin/accounts/${named?.id}`],
	]);
	// Two organisations to choose from, the customer first and chosen.
	const radios = screen
		.getByTestId("demo-destination")
		.querySelectorAll<HTMLInputElement>('input[type="radio"]');
	expect(radios).toHaveLength(3);
	expect(radios[0]?.checked).toBe(true);
});
