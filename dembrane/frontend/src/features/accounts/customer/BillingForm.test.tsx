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
	within,
} from "@testing-library/react";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import * as fx from "../contract/fixtures.gen";

// The form's two calls: the save is caught here, the Peppol directory knows nobody.
const saved = vi.fn();
vi.mock("../api/hooks", () => ({
	useAccountsMutation: () => ({
		error: null,
		isPending: false,
		mutate: saved,
	}),
}));
vi.mock("../api/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("../api/client")>()),
	call: vi.fn(async () => ({ match: null })),
}));
vi.mock("@/components/common/Toaster", () => ({ toast: { success: vi.fn() } }));

const { BillingForm } = await import("./BillingForm");

const empty = fx.accountPage.billing;
const show = (billing = empty) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<QueryClientProvider client={new QueryClient()}>
					<BillingForm orgId="org" billing={billing} pending />
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);

const field = (key: string) =>
	screen.getByTestId(`billing-${key}`) as HTMLInputElement;
const type = (key: string, value: string) =>
	fireEvent.change(field(key), { target: { value } });
const choose = (name: string) => {
	fireEvent.click(field("country"));
	fireEvent.click(screen.getByRole("option", { name }));
};
const fillAddress = () => {
	type("legal_name", "Example Town Council (sample)");
	type("address_line1", "Stadhuisplein 1");
	type("postal_code", "1234 AB");
	type("city", "Example Town");
};
const save = () => fireEvent.click(screen.getByTestId("billing-save"));
const body = () => saved.mock.calls[0]?.[0].body;

beforeAll(() => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	window.matchMedia =
		window.matchMedia ||
		(() => ({
			addEventListener: () => {},
			addListener: () => {},
			matches: false,
			removeEventListener: () => {},
			removeListener: () => {},
		}));
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
	Element.prototype.scrollIntoView = () => {};
});
beforeEach(() => saved.mockClear());
afterEach(cleanup);

describe("the billing details form", () => {
	it("asks the country first, and for no number until it knows the country", () => {
		show();
		const inputs = within(screen.getByTestId("billing")).getAllByRole(
			"textbox",
		);
		expect(inputs[0]).toBe(field("country"));
		expect(screen.queryByTestId("billing-numbers")).toBeNull();
		save();
		expect(saved).not.toHaveBeenCalled();
		expect(screen.getByText("Choose one.")).toBeTruthy();
	});

	it("asks the Netherlands for a KvK or VAT number and says how each looks", () => {
		show();
		choose("Netherlands");
		fillAddress();
		expect(screen.queryByTestId("billing-kbo_number")).toBeNull();
		expect(screen.queryByTestId("billing-no-vat")).toBeNull();
		save();
		expect(saved).not.toHaveBeenCalled();
		type("kvk_number", "1234");
		type("vat_id", "NL12");
		save();
		expect(screen.getByText("A KvK number has 8 digits.")).toBeTruthy();
		expect(
			screen.getByText("Check this. It should look like NL123456789B01."),
		).toBeTruthy();
		expect(saved).not.toHaveBeenCalled();
		type("kvk_number", "1234 5678");
		type("vat_id", "nl 1234.56.789 b01");
		save();
		expect(body()).toMatchObject({
			country_code: "NL",
			invoice_delivery: "email",
			kbo_number: "",
			kvk_number: "12345678",
			no_vat_number: null,
			vat_id: "NL123456789B01",
		});
	});

	it("lets another EU country say it has no VAT number, and Belgium then gives its KBO number", () => {
		show();
		choose("Germany");
		fillAddress();
		expect(screen.queryByTestId("billing-kvk_number")).toBeNull();
		save();
		expect(saved).not.toHaveBeenCalled();
		fireEvent.click(screen.getByTestId("billing-no-vat"));
		expect(field("vat_id").disabled).toBe(true);
		expect(screen.queryByTestId("billing-kbo_number")).toBeNull();
		save();
		expect(body()).toMatchObject({
			country_code: "DE",
			no_vat_number: true,
			vat_id: "",
		});

		saved.mockClear();
		choose("Belgium");
		// Another country starts the numbers over.
		expect(
			(screen.getByTestId("billing-no-vat") as HTMLInputElement).checked,
		).toBe(false);
		fireEvent.click(screen.getByTestId("billing-no-vat"));
		save();
		expect(saved).not.toHaveBeenCalled();
		type("kbo_number", "0123456789");
		save();
		expect(body()).toMatchObject({
			country_code: "BE",
			kbo_number: "0123.456.789",
			no_vat_number: true,
		});
	});

	it("asks a country outside the EU for no number", () => {
		show();
		choose("United Kingdom");
		fillAddress();
		expect(screen.queryByTestId("billing-no-vat")).toBeNull();
		save();
		expect(body()).toMatchObject({
			country_code: "GB",
			no_vat_number: null,
			vat_id: "",
		});
	});

	it("takes an invoice portal only with its name, and a Peppol choice only with an ID", () => {
		show();
		choose("Netherlands");
		fillAddress();
		type("kvk_number", "12345678");
		fireEvent.click(screen.getByTestId("delivery-portal"));
		save();
		expect(saved).not.toHaveBeenCalled();
		type("invoice_portal", "Example supplier portal (sample)");
		save();
		expect(body()).toMatchObject({
			invoice_delivery: "portal",
			invoice_portal: "Example supplier portal (sample)",
			peppol_id: "",
		});

		saved.mockClear();
		fireEvent.click(screen.getByTestId("delivery-peppol"));
		save();
		expect(saved).not.toHaveBeenCalled();
		type("peppol_id", "0190:00000000000000000000");
		save();
		expect(body()).toMatchObject({
			invoice_delivery: "peppol",
			invoice_portal: "",
			peppol_id: "0190:00000000000000000000",
		});
	});

	it("reads a country saved as text before the list existed", () => {
		show({
			...empty,
			country: "Nederland",
			kvk_number: "12345678",
			legal_name: "Example Town Council (sample)",
		});
		expect(field("country").value).toBe("Netherlands");
		expect(field("kvk_number").value).toBe("12345678");
	});
});
