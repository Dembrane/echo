// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	AccountsApiError,
	type RequestOf,
	type ResponseOf,
} from "../../api/client";
import type { RoomPageT, RoomPersonT } from "../../contract/contract.gen";
import * as fx from "../../contract/fixtures.gen";
import { signable } from "./AddPersonModal";
import { AddPersonSteps as AddPersonStepsComponent } from "./AddPersonSteps";

// Adding someone, as steps: who, what they do, send: AddPersonSteps({ me, myEmail,
// people, preset, onSubmit, onCancel, onDone }).
// imported up front, so no test is timed on loading it
const load = async () => AddPersonStepsComponent;

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

type Me = NonNullable<RoomPageT["me"]>;
const admin: Me = {
	app_user_id: "0199a1b6-0000-7000-8000-000000000001",
	labels_question: false,
	may_dismiss_hints: true,
	may_invite_new: true,
	room: "by_role",
};
const colleague: Me = {
	...admin,
	app_user_id: "0199a1b6-0000-7000-8000-000000000002",
	may_dismiss_hints: false,
	may_invite_new: false,
	room: "by_invite",
};
const kim: RoomPersonT = {
	app_user_id: "0199a1b6-0000-7000-8000-000000000003",
	email: "kim@example-town.example",
	id: null,
	invited_at: null,
	invited_by: null,
	labels: [],
	labels_answered_at: null,
	may_relabel: false,
	may_remove: false,
	name: "Kim Example",
	org_role: "member",
	other: null,
	room: "none",
	signs: [],
	status: "member",
};

type Submit = (
	body: RequestOf<"addRoomPerson">,
) => Promise<ResponseOf<"addRoomPerson">>;

const answer = (
	over: Partial<ResponseOf<"addRoomPerson">> = {},
): ResponseOf<"addRoomPerson"> => ({
	email_sent: true,
	person: {
		...kim,
		app_user_id: null,
		email: "anna@example-town.example",
		id: "0199a1b8-0000-7000-8000-000000000009",
		name: "Anna Bakker",
		org_role: null,
		room: "by_invite",
		status: "invited",
	},
	status: "invited",
	workspaces_reached: 0,
	...over,
});

const show = async ({
	me = admin,
	onSubmit = vi.fn<Submit>(async () => answer()),
	people = [kim],
}: {
	me?: Me;
	onSubmit?: ReturnType<typeof vi.fn<Submit>>;
	people?: RoomPersonT[];
} = {}) => {
	const AddPersonSteps = await load();
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider env="test">
				<MemoryRouter>
					<AddPersonSteps
						me={me}
						myEmail="robin@example-town.example"
						people={people}
						onSubmit={onSubmit}
						onCancel={vi.fn()}
						onDone={vi.fn()}
					/>
				</MemoryRouter>
			</MantineProvider>
		</I18nProvider>,
	);
	return onSubmit;
};

const type = (testId: string, value: string) =>
	fireEvent.change(screen.getByTestId(testId), { target: { value } });
const next = () => fireEvent.click(screen.getByTestId("person-next"));

/** Who, then what (with the labels tapped), then the send step. */
const walk = (email: string, name: string, labels: string[] = []) => {
	type("person-name", name);
	type("person-email", email);
	next();
	for (const l of labels) fireEvent.click(screen.getByTestId(`label-${l}`));
	next();
};

describe("the row of steps", () => {
	it("has Back as a text-only button on the left and Continue filled on the right", async () => {
		await show();
		type("person-name", "Anna Bakker");
		type("person-email", "anna@example-town.example");
		next();
		const back = screen.getByTestId("person-back");
		const go = screen.getByTestId("person-next");
		const row = go.parentElement as HTMLElement;
		expect(row.hasAttribute("data-steps")).toBe(true);
		expect(back.parentElement).toBe(row);
		expect(back.getAttribute("data-variant")).toBe("subtle");
		expect(go.getAttribute("data-variant")).toBe("filled");
		expect(
			back.compareDocumentPosition(go) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});
});

describe("who", () => {
	it("asks for a name and one email address, never the address twice", async () => {
		await show();
		expect(screen.getByTestId("person-name")).toBeTruthy();
		expect(document.querySelectorAll('input[type="email"]')).toHaveLength(1);
		expect(document.body.textContent ?? "").not.toMatch(
			/again|repeat|confirm/i,
		);
	});

	it("flags an address outside the inviter's domain, and still lets them go on", async () => {
		await show();
		type("person-name", "Anna Bakker");
		type("person-email", "anna@gmail.example");
		expect(screen.getByTestId("person-outside-domain").textContent).toContain(
			"gmail.example",
		);
		next();
		expect(screen.getByTestId("label-go_ahead")).toBeTruthy();
	});

	it("does not flag an address on the inviter's own domain", async () => {
		await show();
		type("person-email", "anna@example-town.example");
		expect(screen.queryByTestId("person-outside-domain")).toBeNull();
	});

	it("fills in the name of a member they type the address of", async () => {
		await show();
		type("person-email", "kim@example-town.example");
		expect((screen.getByTestId("person-name") as HTMLInputElement).value).toBe(
			"Kim Example",
		);
	});
});

describe("what they do", () => {
	it("offers the six labels and Other as complete boxes with the grammar's chosen state", async () => {
		await show();
		type("person-name", "Anna Bakker");
		type("person-email", "anna@example-town.example");
		next();
		const choices = [
			"go_ahead",
			"rollout",
			"it_security",
			"privacy_ai",
			"contract_purchasing",
			"staff_stakeholders",
			"other",
		].map((l) => screen.getByTestId(`label-${l}`));
		for (const c of choices) {
			expect(c.classList.contains("app-do")).toBe(true);
			expect(c.classList.contains("app-choice")).toBe(true);
			expect(c.hasAttribute("data-selected")).toBe(false);
		}
		expect(document.querySelector(".mantine-Chip-root")).toBeNull();
		expect(document.body.textContent ?? "").not.toMatch(/Will use it/);
		fireEvent.click(screen.getByTestId("label-it_security"));
		expect(
			screen.getByTestId("label-it_security").hasAttribute("data-selected"),
		).toBe(true);
	});

	it("is optional, takes several, one tap each, and sends them in the contract's order", async () => {
		const onSubmit = await show();
		walk("anna@example-town.example", "Anna Bakker", [
			"privacy_ai",
			"go_ahead",
		]);
		next();
		await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
		expect(onSubmit.mock.calls[0]?.[0]).toEqual({
			email: "anna@example-town.example",
			labels: ["go_ahead", "privacy_ai"],
			name: "Anna Bakker",
			other: null,
		});
	});

	it("sends nobody's labels as none: they are kept informed", async () => {
		const onSubmit = await show();
		walk("anna@example-town.example", "Anna Bakker");
		next();
		await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
		expect(onSubmit.mock.calls[0]?.[0].labels).toEqual([]);
	});
});

describe("send", () => {
	it("repeats the outside-domain flag before sending", async () => {
		await show();
		walk("anna@gmail.example", "Anna Bakker");
		expect(screen.getByTestId("person-outside-domain").textContent).toContain(
			"gmail.example",
		);
	});

	it("says the server's own words when someone may not bring in a non-member", async () => {
		const refused = vi.fn<Submit>(async () => {
			throw new AccountsApiError(
				403,
				"Only an owner or admin can bring in someone who is not a member yet",
				{},
				{
					action: "contact_admin",
					code: "room.new_person_admins_only",
					detail:
						"Only an owner or admin can bring in someone who is not a member yet",
					params: {},
				},
			);
		});
		await show({ me: colleague, onSubmit: refused });
		walk("anna@example-town.example", "Anna Bakker");
		next();
		expect(
			await screen.findByText(
				"Only an owner or admin can invite someone who is not a member yet. You can add a colleague who is already a member.",
				{},
				{ timeout: 30_000 },
			),
		).toBeTruthy();
		expect(screen.queryByTestId("person-sent")).toBeNull();
		expect(
			screen.queryByText(
				"You do not have permission to do this. Ask your admin for access.",
			),
		).toBeNull();
	}, 30_000);

	it("after inviting someone new, says how many workspaces they will also be in", async () => {
		await show({
			onSubmit: vi.fn<Submit>(async () => answer({ workspaces_reached: 2 })),
		});
		walk("anna@example-town.example", "Anna Bakker");
		next();
		const line = await screen.findByTestId("person-workspaces");
		expect(line.textContent).toMatch(/\b2 workspaces\b/);
		expect(screen.getByTestId("person-sent")).toBeTruthy();
	});

	it("says nothing about workspaces when there are none, or for a member already", async () => {
		await show({
			onSubmit: vi.fn<Submit>(async () => answer({ workspaces_reached: 0 })),
		});
		walk("anna@example-town.example", "Anna Bakker");
		next();
		await screen.findByTestId("person-sent");
		expect(screen.queryByTestId("person-workspaces")).toBeNull();
		cleanup();
		await show({
			onSubmit: vi.fn<Submit>(async () =>
				answer({ status: "added", workspaces_reached: null }),
			),
		});
		walk("kim@example-town.example", "Kim Example");
		next();
		await screen.findByTestId("person-sent");
		expect(screen.queryByTestId("person-workspaces")).toBeNull();
	});
});

// Correction B: signing is set in the same flow, under the labels, as the signing markers,
// for those who may name a signer; a change of signer is confirmed inside the dialog.
describe("signing, in the same flow", () => {
	type OnName = (
		kind: "offer" | "dpa",
		documentId: string,
		body: { email: string; name: string; role: string | null },
	) => Promise<unknown>;
	const OFFER = "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";
	const DPA = "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a3c";
	const showSigning = async ({
		me = admin,
		offerSigner = null,
		preset,
	}: {
		me?: Me;
		offerSigner?: { email: string; name: string } | null;
		preset?: { signs?: ("offer" | "dpa")[] };
	} = {}) => {
		const AddPersonSteps = await load();
		const onSubmit = vi.fn<Submit>(async () => answer());
		const onName = vi.fn<OnName>(async () => ({}));
		render(
			<I18nProvider i18n={i18n}>
				<MantineProvider env="test">
					<MemoryRouter>
						<AddPersonSteps
							me={me}
							myEmail="robin@example-town.example"
							people={[kim]}
							preset={preset}
							signing={{
								docs: {
									dpa: { documentId: DPA, signer: null },
									offer: { documentId: OFFER, signer: offerSigner },
								},
								onName,
							}}
							onSubmit={onSubmit}
							onCancel={vi.fn()}
							onDone={vi.fn()}
						/>
					</MemoryRouter>
				</MantineProvider>
			</I18nProvider>,
		);
		return { onName, onSubmit };
	};
	const toWhat = () => {
		type("person-name", "Anna Bakker");
		type("person-email", "anna@example-town.example");
		next();
	};

	it("shows Signs the offer and Signs the DPA as choices led by the pen, apart from the labels", async () => {
		await showSigning();
		toWhat();
		for (const kind of ["offer", "dpa"]) {
			const choice = screen.getByTestId(`sign-${kind}`);
			expect(choice.querySelector("svg")).not.toBeNull();
			expect(choice.classList.contains("app-choice")).toBe(true);
			expect(choice.hasAttribute("data-label")).toBe(false);
			expect(choice.closest('[role="group"]')?.getAttribute("aria-label")).toBe(
				"Signing",
			);
		}
		expect(screen.getByTestId("sign-offer").textContent).toContain(
			"Signs the offer",
		);
		expect(screen.getByTestId("sign-dpa").textContent).toContain(
			"Signs the DPA",
		);
	});

	it("asks the optional job title only once a signing duty is chosen", async () => {
		await showSigning();
		toWhat();
		expect(screen.queryByTestId("person-job")).toBeNull();
		fireEvent.click(screen.getByTestId("sign-offer"));
		expect(screen.getByTestId("sign-offer").hasAttribute("data-selected")).toBe(
			true,
		);
		expect(screen.getByTestId("person-job")).toBeTruthy();
	});

	it("names the signer with the job title, then brings them in, never as a label", async () => {
		const { onName, onSubmit } = await showSigning();
		toWhat();
		fireEvent.click(screen.getByTestId("sign-offer"));
		type("person-job", "Wethouder");
		next();
		next();
		await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
		expect(onName).toHaveBeenCalledWith("offer", OFFER, {
			email: "anna@example-town.example",
			name: "Anna Bakker",
			role: "Wethouder",
		});
		expect(onSubmit.mock.calls[0]?.[0].labels).toEqual([]);
	});

	it("confirms inside the dialog before taking a document from someone who signs it now", async () => {
		const { onName, onSubmit } = await showSigning({
			offerSigner: { email: "noor@example-town.example", name: "Noor Example" },
		});
		toWhat();
		expect(screen.queryByTestId("sign-offer-replaces")).toBeNull();
		fireEvent.click(screen.getByTestId("sign-offer"));
		expect(screen.getByTestId("sign-offer-replaces").textContent).toBe(
			"Replaces Noor Example",
		);
		next();
		next();
		expect(screen.getByTestId("new-signer-notice").textContent).toContain(
			"Noor Example no longer signs it",
		);
		expect(onName).not.toHaveBeenCalled();
		expect(onSubmit).not.toHaveBeenCalled();
		next();
		await vi.waitFor(() => expect(onName).toHaveBeenCalledTimes(1));
	});

	it("opens with the signing duty chosen when the flow starts from who signs", async () => {
		await showSigning({ preset: { signs: ["dpa"] } });
		toWhat();
		expect(screen.getByTestId("sign-dpa").hasAttribute("data-selected")).toBe(
			true,
		);
		expect(screen.getByTestId("person-job")).toBeTruthy();
	});

	it("offers no document to sign where the server says no signer may be named", async () => {
		const open = {
			...fx.accountPage,
			documents: fx.accountPage.documents.map((d) => ({
				...d,
				requires_signature: true,
				status: "sent" as const,
			})),
		};
		expect(Object.keys(signable(fx.roomPage, open)).length).toBeGreaterThan(0);
		const refused = {
			...open,
			documents: open.documents.map((d) => ({ ...d, may_name_signer: false })),
		};
		expect(signable(fx.roomPage, refused)).toEqual({});
	});
});
