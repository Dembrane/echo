// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { RoomPageT, RoomPersonT } from "../../contract/contract.gen";

// The one people component, decision lens: PeopleList({ lens, page, onAdd, onChange,
// onRemove, onDismissHint }).
const load = async () => (await import("./PeopleList")).PeopleList;

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

const ME = "0199a1b6-0000-7000-8000-000000000001";
const person = (
	name: string,
	over: Partial<RoomPersonT> = {},
): RoomPersonT => ({
	app_user_id: null,
	email: `${name.split(" ")[0]?.toLowerCase()}@example-town.example`,
	id: null,
	invited_at: null,
	invited_by: null,
	labels: [],
	labels_answered_at: null,
	may_relabel: false,
	may_remove: false,
	name,
	org_role: "member",
	other: null,
	room: "by_invite",
	signs: [],
	status: "member",
	...over,
});

const people = [
	person("Eva Example"),
	person("Sam Example", { labels: ["it_security"] }),
	person("Bo Example", { org_role: "billing", room: "by_role" }),
	person("Robin Example", {
		app_user_id: ME,
		labels: ["go_ahead", "contract_purchasing"],
		org_role: "admin",
		room: "by_role",
	}),
	person("Noor Example", {
		id: "0199a1b8-0000-7000-8000-000000000003",
		org_role: null,
		signs: ["offer", "dpa"],
		status: "invited",
	}),
	person("Kim Example", { room: "none" }),
];

const page = (over: Partial<RoomPageT> = {}): RoomPageT => ({
	dismissed_hints: [],
	me: {
		app_user_id: ME,
		labels_question: false,
		may_dismiss_hints: true,
		may_invite_new: true,
		room: "by_role",
	},
	people,
	signers: { dpa: null, offer: null },
	...over,
});

const show = async (p: RoomPageT, handlers: Record<string, unknown> = {}) => {
	const PeopleList = await load();
	const props = {
		lens: "decision" as const,
		onAdd: vi.fn(),
		onChange: vi.fn(),
		onDismissHint: vi.fn(),
		onRemove: vi.fn(),
		page: p,
		...handlers,
	};
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider env="test">
				<MemoryRouter>
					<PeopleList {...props} />
				</MemoryRouter>
			</MantineProvider>
		</I18nProvider>,
	);
	return props;
};

const rowNames = (root: HTMLElement) =>
	within(root)
		.queryAllByTestId("room-person")
		.map((r) => r.getAttribute("data-email"));

describe("the decision lens", () => {
	it("leads with who signs or holds a label, and folds everyone else under Other members", async () => {
		await show(page());
		const list = screen.getByTestId("people-list");
		const fold = screen.getByTestId("other-members");
		fireEvent.click(screen.getByTestId("other-members-toggle"));
		const lead = rowNames(list).filter(
			(e) => !rowNames(fold).includes(e as string),
		);
		expect(lead).toEqual([
			"noor@example-town.example",
			"robin@example-town.example",
			"sam@example-town.example",
		]);
		// For those who run the account the fold also holds the members not added yet.
		expect(rowNames(fold)).toEqual([
			"bo@example-town.example",
			"eva@example-town.example",
			"kim@example-town.example",
		]);
		expect(
			within(screen.getByTestId("other-members-toggle")).getByText(
				"Other members",
			),
		).toBeTruthy();
	});

	it("shows those who run the account the members not added yet, marked so, with one action to add them", async () => {
		const props = await show(page());
		fireEvent.click(screen.getByTestId("other-members-toggle"));
		const kim = within(screen.getByTestId("other-members"))
			.getAllByTestId("room-person")
			.find(
				(r) => r.getAttribute("data-email") === "kim@example-town.example",
			) as HTMLElement;
		expect(within(kim).getByText("not added yet")).toBeTruthy();
		expect(within(kim).queryByTestId("person-menu")).toBeNull();
		fireEvent.click(within(kim).getByTestId("person-bring-in"));
		expect(props.onAdd).toHaveBeenCalledWith({
			person: { email: "kim@example-town.example", name: "Kim Example" },
		});
	});

	it("gives your own row the same menu, to change what you do and never to remove yourself", async () => {
		const mine = {
			...people[3],
			may_relabel: true,
			may_remove: false,
		} as RoomPersonT;
		const props = await show(
			page({ people: people.map((p) => (p.app_user_id === ME ? mine : p)) }),
		);
		const robin = screen
			.getAllByTestId("room-person")
			.find(
				(r) => r.getAttribute("data-email") === "robin@example-town.example",
			) as HTMLElement;
		fireEvent.click(within(robin).getByTestId("person-menu"));
		expect((await screen.findByTestId("person-change")).textContent).toBe(
			"Change what I do",
		);
		expect(screen.queryByTestId("person-remove")).toBeNull();
		fireEvent.click(screen.getByTestId("person-change"));
		expect(props.onChange).toHaveBeenCalledWith(mine);
	});

	it("tags labels by their words, signing as an outlined marker with the pen, and nobody as 'informed'", async () => {
		await show(page());
		const noor = screen
			.getAllByTestId("room-person")
			.find(
				(r) => r.getAttribute("data-email") === "noor@example-town.example",
			) as HTMLElement;
		const offer = noor.querySelector('[data-sign="offer"]') as HTMLElement;
		const dpa = noor.querySelector('[data-sign="dpa"]') as HTMLElement;
		expect(offer.textContent).toContain("Signs the offer");
		expect(dpa.textContent).toContain("Signs the DPA");
		expect(offer.getAttribute("data-variant")).toBe("outline");
		expect(offer.querySelector("svg")).not.toBeNull();
		// Signing is never a label.
		expect(noor.querySelector("[data-label]")).toBeNull();
		const robin = screen
			.getAllByTestId("room-person")
			.find(
				(r) => r.getAttribute("data-email") === "robin@example-town.example",
			) as HTMLElement;
		expect(
			[...robin.querySelectorAll("[data-label]")].map((t) => t.textContent),
		).toEqual(["Gives the go-ahead", "Handles contract"]);
		const text = document.body.textContent ?? "";
		expect(text).not.toMatch(/Will use it/);
		expect(text).not.toMatch(/Keeping informed|Kept informed/);
	});

	it("marks someone invited and not yet joined", async () => {
		await show(page());
		const noor = screen
			.getAllByTestId("room-person")
			.find(
				(r) => r.getAttribute("data-email") === "noor@example-town.example",
			) as HTMLElement;
		expect(within(noor).getByText("invited")).toBeTruthy();
	});
});

describe("the 'nobody does this yet' hint", () => {
	it("shows the first missing one above Other members", async () => {
		await show(page());
		const hint = screen.getByTestId("room-hint");
		expect(hint.getAttribute("data-label")).toBe("privacy_ai");
		expect(hint.textContent).toContain(
			"Nobody checks privacy and AI rules yet.",
		);
		expect(screen.getAllByTestId("room-hint")).toHaveLength(1);
		const fold = screen.getByTestId("other-members");
		expect(
			hint.compareDocumentPosition(fold) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("offers to add someone for it, with that label chosen", async () => {
		const props = await show(page());
		fireEvent.click(screen.getByTestId("hint-add"));
		expect(props.onAdd).toHaveBeenCalledWith({ labels: ["privacy_ai"] });
	});

	it("can be dismissed by those the server lets, and only them", async () => {
		const props = await show(page());
		fireEvent.click(screen.getByTestId("hint-dismiss"));
		expect(props.onDismissHint).toHaveBeenCalledWith("privacy_ai");
		cleanup();
		await show(
			page({
				me: {
					app_user_id: ME,
					labels_question: false,
					may_dismiss_hints: false,
					may_invite_new: false,
					room: "by_invite",
				},
			}),
		);
		expect(screen.getByTestId("room-hint")).toBeTruthy();
		expect(screen.queryByTestId("hint-dismiss")).toBeNull();
	});

	it("is gone once dismissed or held, and shows the next one", async () => {
		await show(page({ dismissed_hints: ["privacy_ai"] }));
		expect(screen.queryByTestId("room-hint")).toBeNull();
		cleanup();
		await show(page({ people: [person("Eva Example")] }));
		expect(screen.getByTestId("room-hint").getAttribute("data-label")).toBe(
			"go_ahead",
		);
	});
});

describe("the access lens", () => {
	it("is the same component with the organisation role leading instead of tags", async () => {
		await show(page(), { lens: "access" });
		expect(screen.getByTestId("people-list").getAttribute("data-lens")).toBe(
			"access",
		);
		const bo = screen
			.getAllByTestId("room-person")
			.find(
				(r) => r.getAttribute("data-email") === "bo@example-town.example",
			) as HTMLElement;
		expect(bo.textContent).toContain("Billing");
	});
});
