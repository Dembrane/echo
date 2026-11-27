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
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as fx from "../../contract/fixtures.gen";

// The room's own row: the same "..." menu as anyone's, "Change what I do", opening the
// one change flow titled "What do you do?", which saves through answerRoomLabels.

const ROBIN = "robin@example-town.example";
const calls: { name: string; body?: unknown }[] = [];
// The server as far as this screen needs it: answerRoomLabels changes Robin's own row and
// answers with it, and the room the mutation then refreshes shows the change.
let people = fx.roomPage.people;
vi.mock("../../api/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../api/client")>()),
	call: vi.fn(async (name: string, opts?: { body?: unknown }) => {
		calls.push({ body: opts?.body, name });
		if (name === "roomPage") return { ...fx.roomPage, people };
		if (name === "accountPage") return fx.accountPage;
		if (name === "answerRoomLabels") {
			const body = opts?.body as { labels: string[]; other: string | null };
			people = people.map((p) =>
				p.email === ROBIN
					? {
							...p,
							labels: body.labels as typeof p.labels,
							labels_answered_at: "2026-09-28T12:00:00.000Z",
							other: body.other,
						}
					: p,
			);
			return people.find((p) => p.email === ROBIN);
		}
		throw new Error(`unexpected call ${name}`);
	}),
}));
vi.mock("@/hooks/useV2Me", () => ({
	useV2Me: () => ({ data: { email: "robin@example-town.example" } }),
}));

const { RoomSection } = await import("./RoomSection");

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

describe("changing what you do yourself", () => {
	it("opens the change flow on your own row, asks what you do, and saves your own answer", async () => {
		render(
			<I18nProvider i18n={i18n}>
				<MantineProvider env="test">
					<QueryClientProvider
						client={
							new QueryClient({ defaultOptions: { queries: { retry: false } } })
						}
					>
						<MemoryRouter>
							<RoomSection orgId={fx.accountPage.organisation.id} />
						</MemoryRouter>
					</QueryClientProvider>
				</MantineProvider>
			</I18nProvider>,
		);
		const robinRow = async () =>
			(await screen.findAllByTestId("room-person")).find(
				(r) => r.getAttribute("data-email") === ROBIN,
			) as HTMLElement;
		const robin = await robinRow();
		expect(within(robin).queryByText("Checks IT and security")).toBeNull();
		fireEvent.click(within(robin).getByTestId("person-menu"));
		fireEvent.click(await screen.findByTestId("person-change"));
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText("What do you do?")).toBeTruthy();
		// Who signs is not chosen here: that is for "Tell us who signs".
		expect(within(dialog).queryByRole("group", { name: "Signing" })).toBeNull();
		fireEvent.click(within(dialog).getByTestId("label-it_security"));
		fireEvent.click(within(dialog).getByTestId("person-next"));
		await waitFor(() =>
			expect(
				calls.find((c) => c.name === "answerRoomLabels")?.body,
			).toMatchObject({ other: null }),
		);
		expect(
			(
				calls.find((c) => c.name === "answerRoomLabels")?.body as {
					labels: string[];
				}
			).labels.sort(),
		).toEqual(["contract_purchasing", "go_ahead", "it_security"]);
		expect(calls.some((c) => c.name === "addRoomPerson")).toBe(false);
		// After saving: the dialog closes and Robin's own row says what they do now.
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		await waitFor(async () =>
			expect(
				within(await robinRow()).getByText("Checks IT and security"),
			).toBeTruthy(),
		);
	});
});
