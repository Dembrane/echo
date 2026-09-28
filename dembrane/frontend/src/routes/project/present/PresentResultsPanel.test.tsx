// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Presentation } from "@/components/present/hooks";
import { PresentResultsPanel } from "./PresentResultsPanel";

vi.mock("@/lib/bff", () => ({
	bff: {
		delete: vi.fn().mockResolvedValue({ myFeedback: null }),
		get: vi.fn().mockResolvedValue({ revisions: [] }),
		post: vi.fn(),
		put: vi.fn().mockResolvedValue({ myFeedback: null }),
	},
}));
const items = [
	{
		conversationCount: 1,
		conversationName: "Marloes",
		detail: {
			evidence: [
				{
					conversationId: "c1",
					label: "Marloes",
					quotes: ["We waited and waited, a short phrase of it."],
				},
			],
		},
		objectId: "obj-1",
		payload: { phrase: "A short phrase" },
		quoteCount: 1,
		revisionId: "rev-1",
		type: "popcorn",
	},
	{
		objectId: "obj-2",
		payload: {
			knot: "Who pays for the waiting",
			poleA: "Open longer",
			poleB: "Pay people",
			quotes: [
				{ conversationId: "c1", pole: "A", text: "Stay open past six." },
				{ conversationId: "c2", pole: "B", text: "Pay us for the hours." },
			],
			toResolve: "Whether the budget stretches",
		},
		revisionId: "rev-2",
		type: "tension",
	},
];
vi.mock("@/components/analysis", () => ({
	useResultsList: () => ({
		canEdit: true,
		counts: { popcorn: 1, tension: 1 },
		items,
		loadingTypes: [],
		loadMore: () => {},
		total: 2,
	}),
	useResultsVisit: () => null,
}));
const save = vi.fn();
vi.mock("@/components/popcorn/hooks", () => ({
	usePopcornSettingsMutation: () => ({ mutate: save }),
}));

const presentation = {
	id: "screen",
	settings: { presentation: { blocks: ["popcorn"], hidden_items: [] } },
} as unknown as Presentation;

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
	window.matchMedia = vi.fn().mockImplementation((media) => ({
		addEventListener() {},
		matches: false,
		media,
		removeEventListener() {},
	}));
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function show(entry = "/present", onTabChange?: (block: string) => void) {
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
	});
	render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={client}>
				<MantineProvider>
					<MemoryRouter initialEntries={[entry]}>
						<PresentResultsPanel
							onTabChange={onTabChange}
							projectId="project"
							presentation={presentation}
						/>
					</MemoryRouter>
				</MantineProvider>
			</QueryClientProvider>
		</I18nProvider>,
	);
}

describe("The four tabs of the results panel", () => {
	it("is a tablist of the room's own four, counted, with the off ones last", () => {
		show();
		expect(screen.getByRole("region", { name: "Review results" })).toBeTruthy();
		const tabs = screen.getAllByRole("tab");
		expect(tabs.map((tab) => tab.textContent)).toEqual([
			"Popcorn1",
			"Tensions1off",
			"Arguments0off",
			"Stakeholders0off",
		]);
		// The one the presentation shows leads, and is the one being read.
		expect(tabs[0].getAttribute("aria-selected")).toBe("true");
		expect(screen.getByText("A short phrase")).toBeTruthy();
	});

	it("opens the tab the address asks for, and writes the one chosen into it", () => {
		const told: string[] = [];
		show("/present?results=tensions", (block) => told.push(block));
		expect(
			screen.getByTestId("curate-tab-tensions").getAttribute("aria-selected"),
		).toBe("true");
		expect(screen.getAllByText("Open longer").length).toBeGreaterThan(0);
		expect(screen.getByText("Who pays for the waiting")).toBeTruthy();
		fireEvent.click(screen.getByTestId("curate-tab-popcorn"));
		expect(told).toEqual(["popcorn"]);
		expect(
			screen.getByTestId("curate-tab-popcorn").getAttribute("aria-selected"),
		).toBe("true");
	});

	it("keeps taking ?results=1, which opened this panel before it had tabs", () => {
		show("/present?results=1");
		expect(
			screen.getByTestId("curate-tab-popcorn").getAttribute("aria-selected"),
		).toBe("true");
	});

	it("walks the tabs with the arrow keys", () => {
		show();
		fireEvent.keyDown(screen.getByTestId("curate-tabs"), {
			key: "ArrowRight",
		});
		expect(
			screen.getByTestId("curate-tab-tensions").getAttribute("aria-selected"),
		).toBe("true");
	});

	it("says a block is not in this presentation, and turns it on where it stands", () => {
		show("/present?results=tensions");
		expect(screen.getByText("Not in this presentation.")).toBeTruthy();
		// The findings are still there to be read, dimmed: a host deciding
		// whether to turn a tab on wants to see what is in it.
		expect(screen.getAllByText("Open longer").length).toBeGreaterThan(0);
		fireEvent.click(screen.getByRole("switch", { name: "Tensions" }));
		expect(save).toHaveBeenCalledWith({
			presentation: { blocks: ["popcorn", "tensions"] },
		});
	});
});

describe("Hiding a finding from this presentation", () => {
	it("takes one click, with no reason asked for", () => {
		show();
		fireEvent.click(
			screen.getByRole("button", { name: "Hide from this presentation" }),
		);
		expect(save).toHaveBeenCalledWith({
			presentation: { hidden_items: ["obj-1"] },
		});
		expect(screen.queryByText("Why not in this presentation?")).toBeNull();
		// No quiet line, no countdown: the eye is the whole of it.
		expect(screen.queryByTestId("curate-held-obj-1")).toBeNull();
		expect(screen.queryByText("add a reason")).toBeNull();
	});

	it("counts what is hidden and filters the tab down to it", () => {
		show();
		expect(screen.queryByTestId("curate-hidden-filter")).toBeNull();
		fireEvent.click(
			screen.getByRole("button", { name: "Hide from this presentation" }),
		);
		const filter = screen.getByTestId("curate-hidden-filter");
		expect(filter.textContent).toBe("1 hidden");
		fireEvent.click(filter);
		expect(filter.getAttribute("aria-pressed")).toBe("true");
		// Showing it again is on the same glyph, in the same place, always.
		expect(screen.getByRole("button", { name: "Show again" })).toBeTruthy();
	});

	it("puts a finding back on the eye it was taken out with", () => {
		show();
		fireEvent.click(
			screen.getByRole("button", { name: "Hide from this presentation" }),
		);
		save.mockClear();
		fireEvent.click(screen.getByRole("button", { name: "Show again" }));
		expect(save).toHaveBeenCalledWith({
			presentation: { hidden_items: [] },
		});
	});
});

describe("Opening a finding in this panel", () => {
	it("shows the evidence, not the card the room gets", () => {
		show();
		expect(screen.queryByTestId("result-stage")).toBeNull();
		fireEvent.click(screen.getByTestId("curate-pop-obj-1"));
		expect(screen.getByTestId("curate-open-obj-1")).toBeTruthy();
		// The phrase is marked inside the sentence it was cut from, in the
		// sentence's own casing, by weight and never by colour.
		expect(screen.getByTestId("curate-quote").textContent).toContain(
			"We waited and waited",
		);
		expect(
			screen.getByTestId("curate-quote").querySelector("span")?.textContent,
		).toBe("a short phrase");
		// The stage card is a click deeper, never under the row by itself.
		expect(screen.queryByTestId("result-stage")).toBeNull();
		expect(screen.queryByTestId("result-item")).toBeNull();
	});

	it("keeps the workbench one click further, behind History / details", () => {
		show();
		fireEvent.click(screen.getByTestId("curate-pop-obj-1"));
		fireEvent.click(screen.getByTestId("curate-details-obj-1"));
		expect(screen.getByTestId("result-item")).toBeTruthy();
		expect(screen.getByTestId("result-stage")).toBeTruthy();
	});

	it("keeps withdrawing from the analysis a thing you have to say why for", () => {
		show();
		fireEvent.click(screen.getByTestId("curate-pop-obj-1"));
		fireEvent.click(screen.getByTestId("curate-withdraw-open-obj-1"));
		expect(screen.getByText("Withdraw this from the analysis?")).toBeTruthy();
	});
});
