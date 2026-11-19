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
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DocumentDetailT } from "../contract/contract.gen";
import * as fx from "../contract/fixtures.gen";
import { CustomerSignerLine, customerSignerBody } from "./CustomerSigner";
import { PushOfferModal } from "./PushOfferModal";

// Staff name who signs for the customer: the line on an offer or a DPA, and the dialog
// that names or changes them through the staff route.
const calls: { name: string; options: unknown }[] = [];
vi.mock("../api/client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../api/client")>();
	return {
		...actual,
		call: vi.fn(async (name: string, options: unknown) => {
			calls.push({ name, options });
			if (name === "accountCard") return fx.accountCard;
			if (name === "pushOffer") return fx.pushOfferResponse;
			return { signer: null };
		}),
	};
});

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
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
		disconnect() {}
		observe() {}
		unobserve() {}
	} as unknown as typeof ResizeObserver;
});
afterEach(() => {
	cleanup();
	calls.length = 0;
});

const ROBIN = {
	email: "robin@example-town.example",
	name: "Robin de Vries",
	named_at: "2026-09-28T09:00:00.000Z",
	reminded_at: null,
	role: "Alderman",
};
const offer = (over: Partial<DocumentDetailT> = {}): DocumentDetailT => ({
	...fx.offerDetail,
	access: "staff",
	signatures: [],
	signer: null,
	status: "sent",
	...over,
});

const wrap = (ui: React.ReactNode) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider env="test">
				<QueryClientProvider client={new QueryClient()}>
					{ui}
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);
const show = (doc: DocumentDetailT) =>
	wrap(<CustomerSignerLine orgId="org-1" doc={doc} />);
const sent = (route: string) =>
	calls.find((c) => c.name === route)?.options as {
		body: Record<string, unknown>;
	};

const fill = (name: string, email: string) => {
	fireEvent.change(screen.getByTestId("customer-signer-name"), {
		target: { value: name },
	});
	fireEvent.change(screen.getByTestId("customer-signer-email"), {
		target: { value: email },
	});
};

describe("the customer's signer, for staff", () => {
	it("the request field: nothing typed is null, anything typed goes as typed", () => {
		expect(customerSignerBody({ email: " ", name: "", role: "" })).toBeNull();
		expect(
			customerSignerBody({ email: " a@b.example ", name: " A ", role: "" }),
		).toEqual({ email: "a@b.example", name: "A", role: null });
		// Half filled is sent, so the API says which field is missing.
		expect(customerSignerBody({ email: "", name: "A", role: "" })).toEqual({
			email: "",
			name: "A",
			role: null,
		});
	});

	it("a waiting offer with nobody named says so, and names someone through the staff route", async () => {
		show(offer());
		expect(screen.getByTestId("customer-signer-line").textContent).toContain(
			"Signs the offer:",
		);
		expect(screen.getByTestId("customer-signer-nobody")).toBeTruthy();
		fireEvent.click(screen.getByText("Name the signer"));
		expect(await screen.findByText("Who signs the offer?")).toBeTruthy();
		// One filled button in the dialog: the one that names them.
		expect(
			document.querySelectorAll('button[data-variant="filled"]'),
		).toHaveLength(1);
		fill("Robin de Vries", "robin@example-town.example");
		fireEvent.click(screen.getByTestId("customer-signer-save"));
		await waitFor(() => expect(calls).toHaveLength(1));
		expect(calls[0]).toEqual({
			name: "staffNameSigner",
			options: {
				body: {
					email: "robin@example-town.example",
					name: "Robin de Vries",
					role: null,
				},
				params: { docId: fx.offerDetail.id, orgId: "org-1" },
			},
		});
	});

	it("changing who signs asks first, saying the earlier link stops working", async () => {
		show(offer({ signer: ROBIN }));
		expect(screen.getByTestId("customer-signer-who").textContent).toBe(
			"Robin de Vries, Alderman (robin@example-town.example)",
		);
		fireEvent.click(screen.getByText("Change"));
		expect(await screen.findByText("Change who signs the offer?")).toBeTruthy();
		fill("Sam Jansen", "sam@example-town.example");
		fireEvent.click(screen.getByTestId("customer-signer-save"));
		expect(
			await screen.findByText(
				"Robin de Vries no longer signs it, and the link we sent Robin stops working. Sam Jansen gets a new link.",
			),
		).toBeTruthy();
		expect(calls).toHaveLength(0);
		fireEvent.click(screen.getByTestId("customer-signer-confirm-change"));
		await waitFor(() => expect(calls).toHaveLength(1));
		expect((calls[0]?.options as { body: { email: string } }).body.email).toBe(
			"sam@example-town.example",
		);
	});

	it("naming the same person again asks nothing", async () => {
		show(offer({ signer: ROBIN }));
		fireEvent.click(screen.getByText("Change"));
		await screen.findByText("Change who signs the offer?");
		fill("Robin de Vries", "Robin@Example-Town.example");
		fireEvent.click(screen.getByTestId("customer-signer-save"));
		await waitFor(() => expect(calls).toHaveLength(1));
		expect(screen.queryByTestId("customer-signer-confirm")).toBeNull();
	});

	it("a DPA uses its own wording", async () => {
		show(offer({ kind: "dpa" }));
		expect(screen.getByTestId("customer-signer-line").textContent).toContain(
			"Signs the DPA:",
		);
		fireEvent.click(screen.getByText("Name the signer"));
		expect(await screen.findByText("Who signs the DPA?")).toBeTruthy();
	});

	it("a draft shows whom it will name when sent, with nothing to press", () => {
		show(offer({ signer: { ...ROBIN, named_at: null }, status: "draft" }));
		expect(screen.getByTestId("customer-signer-line").textContent).toContain(
			"They get the link when the offer is sent.",
		);
		expect(screen.queryByTestId("customer-signer-open")).toBeNull();
	});

	it("once the customer has signed, or for a document nobody signs, there is no line", () => {
		show(
			offer({
				signatures: [
					{
						...(fx.signedDpaDetail
							.signatures[0] as DocumentDetailT["signatures"][number]),
						slot: "customer",
					},
				],
				status: "signed",
			}),
		);
		expect(screen.queryByTestId("customer-signer-line")).toBeNull();
		cleanup();
		show(offer({ requires_signature: false }));
		expect(screen.queryByTestId("customer-signer-line")).toBeNull();
	});

	it("the offer form sends the customer's signer when one is typed, and null when not", async () => {
		wrap(
			<PushOfferModal
				opened
				onClose={() => {}}
				orgId="org-1"
				orgName="Example"
			/>,
		);
		await screen.findByText("Who signs for the customer?");
		fireEvent.click(screen.getByTestId("offer-submit"));
		await waitFor(() => expect(sent("pushOffer")).toBeTruthy());
		expect(sent("pushOffer").body.customer_signer).toBeNull();
		cleanup();
		calls.length = 0;

		wrap(
			<PushOfferModal
				opened
				onClose={() => {}}
				orgId="org-1"
				orgName="Example"
			/>,
		);
		await screen.findByText("Who signs for the customer?");
		fill("Robin de Vries", "robin@example-town.example");
		fireEvent.change(screen.getByTestId("customer-signer-role"), {
			target: { value: "Alderman" },
		});
		fireEvent.click(screen.getByTestId("offer-submit"));
		await waitFor(() => expect(sent("pushOffer")).toBeTruthy());
		expect(sent("pushOffer").body.customer_signer).toEqual({
			email: "robin@example-town.example",
			name: "Robin de Vries",
			role: "Alderman",
		});
	});

	it("changing a draft starts from its signer, and emptying the fields drops them", async () => {
		const draft = offer({
			signer: { ...ROBIN, named_at: null },
			status: "draft",
		});
		wrap(
			<PushOfferModal
				opened
				onClose={() => {}}
				orgId="org-1"
				orgName="Example"
				draft={draft}
			/>,
		);
		const name = (await screen.findByTestId(
			"customer-signer-name",
		)) as HTMLInputElement;
		expect(name.value).toBe("Robin de Vries");
		fill("", "");
		fireEvent.click(screen.getByTestId("offer-save-draft"));
		await waitFor(() => expect(sent("updateOffer")).toBeTruthy());
		expect(sent("updateOffer").body.customer_signer).toBeNull();
	});
});
