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
	within,
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
import type { OrgWorkspace } from "./SupportAccess";

vi.mock("@/hooks/useWorkspace", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/hooks/useWorkspace")>()),
	useWorkspace: () => ({ setWorkspace: () => {} }),
}));

const { SupportAccess } = await import("./SupportAccess");

const ORG = "org-1";
const UNTIL = "2026-11-26T14:00:00Z";
const CHANGE_UNTIL = "2026-11-26T09:00:00Z";
const EXPIRES = "2026-12-01T10:00:00Z";
const none = {
	active: false,
	can_change: false,
	change_until: null,
	expires_at: null,
};
const read = {
	active: true,
	can_change: false,
	change_until: null,
	expires_at: UNTIL,
};
const edit = {
	active: true,
	can_change: true,
	change_until: CHANGE_UNTIL,
	expires_at: UNTIL,
};
const waiting = {
	created_at: "2026-11-24T10:00:00Z",
	expires_at: EXPIRES,
	id: "rq",
};

const workspace = (
	name: string,
	over: Partial<OrgWorkspace> = {},
): OrgWorkspace => ({
	held_for_demo: false,
	name,
	request: null,
	support_access_enabled: false,
	visit: none,
	workspace_id: name,
	...over,
});

let list: OrgWorkspace[] = [];

const show = async (workspaces: OrgWorkspace[]) => {
	list = workspaces;
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider env="test">
				<QueryClientProvider
					client={
						new QueryClient({ defaultOptions: { queries: { retry: false } } })
					}
				>
					<MemoryRouter initialEntries={[`/en-US/admin/accounts/${ORG}`]}>
						<Routes>
							<Route
								path="/:language/admin/accounts/:orgId"
								element={<SupportAccess orgId={ORG} />}
							/>
						</Routes>
					</MemoryRouter>
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);
	await waitFor(() =>
		expect(screen.getAllByTestId("staff-support-workspace")).toHaveLength(
			workspaces.length,
		),
	);
};

/** What one row shows: its badge, the line under the name, the button and the menu. */
const rowOf = async (name: string) => {
	const row = screen
		.getAllByTestId("staff-support-workspace")
		.find((r) => r.textContent?.includes(name)) as HTMLElement;
	const button = within(row)
		.queryAllByRole("button")
		.filter((b) => b.getAttribute("data-testid") !== "staff-support-menu");
	const link = within(row).queryAllByRole("link");
	const menu = within(row).queryByTestId("staff-support-menu");
	let items: string[] = [];
	if (menu) {
		fireEvent.click(menu);
		await waitFor(() =>
			expect(screen.getAllByRole("menuitem").length).toBeGreaterThan(0),
		);
		// Each test renders one row and opens its menu once, so the open menu is that row's.
		items = screen.getAllByRole("menuitem").map((m) => m.textContent ?? "");
	}
	return {
		detail:
			within(row).queryByTestId("staff-support-detail")?.textContent ?? "",
		items,
		next: [...button, ...link].map((b) => b.textContent ?? ""),
		state: row.getAttribute("data-state"),
		status: within(row).getByTestId("staff-support-status").textContent,
	};
};

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
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(JSON.stringify({ workspaces: list }), {
					headers: { "Content-Type": "application/json" },
				}),
		),
	);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("the account page's support access rows", () => {
	it("switch off, nothing asked: no access, and asking is the step", async () => {
		await show([workspace("Panels")]);
		expect(await rowOf("Panels")).toEqual({
			detail: "",
			items: [],
			next: ["Request access"],
			state: "none",
			status: "No access",
		});
	});

	it("switch off, asked: the request and when it expires, and taking it back", async () => {
		await show([workspace("Youth", { request: waiting })]);
		const row = await rowOf("Youth");
		expect(row).toMatchObject({
			items: [],
			next: ["Cancel request"],
			state: "request",
			status: "Request sent",
		});
		expect(row.detail).toMatch(/^Expires /);
	});

	it("switch on, not in: join to read, or ask to edit", async () => {
		await show([workspace("Research", { support_access_enabled: true })]);
		expect(await rowOf("Research")).toEqual({
			detail: "",
			items: ["Request access"],
			next: ["Join read-only"],
			state: "on",
			status: "Read access on",
		});
	});

	it("switch on, asked, not in: take the request back, or join to read meanwhile", async () => {
		await show([
			workspace("Mobility", { request: waiting, support_access_enabled: true }),
		]);
		expect(await rowOf("Mobility")).toMatchObject({
			items: ["Join read-only"],
			next: ["Cancel request"],
			state: "request",
			status: "Request sent",
		});
	});

	it("in to read: open it, ask to edit, extend or end the visit", async () => {
		await show([
			workspace("Climate", { support_access_enabled: true, visit: read }),
		]);
		const row = await rowOf("Climate");
		expect(row).toMatchObject({
			items: ["Request access", "Extend visit by 24 hours", "End visit now"],
			next: ["Open"],
			state: "read",
			status: "Read only",
		});
		expect(row.detail).toMatch(/^Until /);
		expect(row.detail).not.toContain("Request");
	});

	it("in to read, asked to edit: the line says so and the menu takes it back", async () => {
		await show([
			workspace("Roofs", {
				request: waiting,
				support_access_enabled: true,
				visit: read,
			}),
		]);
		const row = await rowOf("Roofs");
		expect(row).toMatchObject({
			items: ["Cancel request", "Extend visit by 24 hours", "End visit now"],
			next: ["Open"],
			state: "read",
			status: "Read only",
		});
		expect(row.detail).toMatch(/^Until .+\. Request to edit sent$/);
	});

	it("can edit with the switch on: no asking, and extending is offered", async () => {
		await show([
			workspace("Wijk", { support_access_enabled: true, visit: edit }),
		]);
		expect(await rowOf("Wijk")).toMatchObject({
			items: ["Extend visit by 24 hours", "End visit now"],
			next: ["Open"],
			state: "change",
			status: "Can edit",
		});
	});

	it("can edit with the switch off: only ending the visit, since extending needs the switch", async () => {
		await show([workspace("Wijk", { visit: edit })]);
		expect(await rowOf("Wijk")).toMatchObject({
			items: ["End visit now"],
			next: ["Open"],
			state: "change",
			status: "Can edit",
		});
	});

	it("can edit: the time is when the right to edit ends, not the end of the visit", async () => {
		await show([workspace("Wijk", { visit: edit })]);
		const { detail } = await rowOf("Wijk");
		const at = (iso: string) =>
			new Date(iso).toLocaleTimeString("en-US", {
				hour: "numeric",
				minute: "2-digit",
			});
		expect(detail).toContain(at(CHANGE_UNTIL));
		expect(detail).not.toContain(at(UNTIL));
	});

	it("a demo that is not published: its badge and nothing to do", async () => {
		await show([workspace("Demo", { held_for_demo: true })]);
		expect(await rowOf("Demo")).toEqual({
			detail: "",
			items: [],
			next: [],
			state: "demo",
			status: "Demo draft",
		});
	});

	it("asking opens the note dialog, which names the workspace", async () => {
		await show([workspace("Panels")]);
		fireEvent.click(screen.getByTestId("staff-support-request"));
		const dialog = await screen.findByRole("dialog");
		expect(dialog.textContent).toContain("Tell the admins of Panels");
	});
});
