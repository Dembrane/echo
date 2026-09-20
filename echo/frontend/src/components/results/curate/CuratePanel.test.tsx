// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AnalysisObject } from "@/components/analysis/hooks";
import type { PresentationBlock } from "@/components/present/blocks";
import type { ResultActions } from "../useResultActions";
import { CuratePanel } from "./CuratePanel";
import { POPCORN_AT_REST } from "./PopcornTab";

vi.mock("@/lib/bff", () => ({
	bff: {
		delete: vi.fn().mockResolvedValue({ myFeedback: null }),
		get: vi.fn().mockResolvedValue({ revisions: [] }),
		post: vi.fn(),
		put: vi.fn().mockResolvedValue({ myFeedback: null }),
	},
}));

const pop = (index: number): AnalysisObject =>
	({
		conversationCount: 1,
		conversationName: `Conversation ${index}`,
		detail: {
			evidence: [
				{
					conversationId: `c${index}`,
					label: `Conversation ${index}`,
					quotes: [`And then phrase ${index} came up, plainly.`],
				},
			],
		},
		objectId: `p${index}`,
		payload: { phrase: `phrase ${index}` },
		quoteCount: 1,
		revisionId: `rev-p${index}`,
		type: "popcorn",
	}) as AnalysisObject;

const stakeholder = {
	detail: {
		evidence: [{ conversationId: "c1", label: "Wim", quotes: ["So."] }],
	},
	objectId: "s1",
	payload: {
		name: "Night shift staff",
		role: "Works the late hours",
		rung: "inferred",
		stake: "Whether the doors stay open past six",
	},
	revisionId: "rev-s1",
	type: "stakeholder",
} as unknown as AnalysisObject;

const tension = {
	conversationCount: 3,
	objectId: "t1",
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
	quoteCount: 2,
	revisionId: "rev-t1",
	type: "tension",
} as unknown as AnalysisObject;

function useTestActions(): ResultActions {
	const [held, setHeld] = useState<string[]>([]);
	return {
		editWords: vi.fn(),
		heldBackReasons: [],
		heldReason: () => undefined,
		holdBack: (objectId: string) =>
			setHeld((old) => [...new Set([...old, objectId])]),
		holdBackMany: (objectIds: string[], on: boolean) =>
			setHeld((old) =>
				on
					? [...new Set([...old, ...objectIds])]
					: old.filter((id) => !objectIds.includes(id)),
			),
		isHeld: (objectId: string) => held.includes(objectId),
		pending: false,
		showAgain: (objectId: string) =>
			setHeld((old) => old.filter((id) => id !== objectId)),
		undoWords: vi.fn(),
	} as unknown as ResultActions;
}

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

function Panel({
	items = [],
	blocks = ["popcorn", "tensions", "map", "stakeholders"],
	first = "popcorn",
	loading = false,
	counts,
}: {
	items?: AnalysisObject[];
	blocks?: PresentationBlock[];
	first?: PresentationBlock;
	loading?: boolean;
	counts?: Record<string, number>;
}) {
	const actions = useTestActions();
	const [selected, setSelected] = useState<PresentationBlock>(first);
	return (
		<CuratePanel
			actions={actions}
			analysisHref="/analysis"
			blocks={blocks}
			canEdit
			counts={counts}
			items={items}
			loading={loading}
			onSelect={setSelected}
			projectId="project"
			selected={selected}
		/>
	);
}

function show(props: Parameters<typeof Panel>[0] = {}) {
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
	});
	render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={client}>
				<MantineProvider>
					<MemoryRouter>
						<Panel {...props} />
					</MemoryRouter>
				</MantineProvider>
			</QueryClientProvider>
		</I18nProvider>,
	);
}

const heads = () =>
	screen.getAllByRole("columnheader").map((head) => head.textContent);

describe("The columns each tab carries", () => {
	it("gives popcorn the phrase and the conversation it came from", () => {
		show({ items: [pop(1)] });
		expect(heads()).toEqual(["", "Popcorn phrase", "Source", "Tools"]);
		expect(screen.getByText("phrase 1")).toBeTruthy();
		expect(screen.getByText("Conversation 1")).toBeTruthy();
	});

	it("gives a tension both poles, the knot under them, and a source", () => {
		show({ first: "tensions", items: [tension] });
		expect(heads()).toEqual(["", "Tension", "Source", "Tools"]);
		expect(screen.getByText("Open longer")).toBeTruthy();
		expect(screen.getByText("Pay people")).toBeTruthy();
		expect(screen.getByText("Who pays for the waiting")).toBeTruthy();
		// No name for the conversations, so the count says it.
		expect(screen.getByText("3 conversations")).toBeTruthy();
		// The cards are gone: the evidence is a row-click away like everywhere.
		expect(screen.queryByTestId("curate-poles")).toBeNull();
	});

	it("gives stakeholders name, role, stake and source, the rung after the name", () => {
		show({ first: "stakeholders", items: [stakeholder] });
		expect(heads()).toEqual(["", "Name", "Role", "Stake", "Source", "Tools"]);
		expect(screen.getByText("Night shift staff")).toBeTruthy();
		expect(screen.getByText("Inferred")).toBeTruthy();
	});

	it("holds popcorn at forty, then offers the whole set", () => {
		const many = Array.from({ length: POPCORN_AT_REST + 5 }, (_, at) =>
			pop(at + 1),
		);
		show({ counts: { popcorn: many.length }, items: many });
		expect(screen.getAllByTestId(/^curate-pop-/).length).toBe(POPCORN_AT_REST);
		fireEvent.click(screen.getByTestId("curate-show-all-popcorn"));
		expect(screen.getAllByTestId(/^curate-pop-/).length).toBe(many.length);
	});
});

describe("Opening a finding", () => {
	it("opens the row on a click on its words, and says so", () => {
		show({ items: [pop(1)] });
		const row = screen.getByTestId("curate-pop-p1");
		expect(row.getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(screen.getByText("phrase 1"));
		expect(
			screen.getByTestId("curate-pop-p1").getAttribute("aria-expanded"),
		).toBe("true");
		const quote = screen.getByTestId("curate-quote");
		expect(quote.textContent).toContain("And then phrase 1 came up");
		expect(quote.querySelector("span")?.textContent).toBe("phrase 1");
	});

	it("leaves the row shut when a control of its own is used", () => {
		show({ items: [pop(1)] });
		fireEvent.click(screen.getByTestId("curate-pick-p1"));
		expect(
			screen.getByTestId("curate-pop-p1").getAttribute("aria-expanded"),
		).toBe("false");
	});

	it("keeps the whole picture out of the foot, where a tool says it", () => {
		show({ items: [pop(1)] });
		fireEvent.click(screen.getByText("phrase 1"));
		expect(screen.getByText("Withdraw from the analysis")).toBeTruthy();
		expect(screen.getByText("History / details")).toBeTruthy();
		expect(screen.queryByText("Open in Analysis")).toBeNull();
	});
});

describe("Deciding about many at once", () => {
	it("ticks every row shown, and says so on the head when only some are", () => {
		show({ items: [pop(1), pop(2)] });
		const all = screen.getByTestId("curate-select-all") as HTMLInputElement;
		fireEvent.click(screen.getByTestId("curate-pick-p1"));
		expect(all.indeterminate).toBe(true);
		fireEvent.click(screen.getByTestId("curate-select-all"));
		expect(
			(screen.getByTestId("curate-pick-p2") as HTMLInputElement).checked,
		).toBe(true);
		expect(screen.getByTestId("curate-bulk").textContent).toContain(
			"2 selected",
		);
	});

	it("hides the whole selection, and shows it again", () => {
		show({ items: [pop(1), pop(2)] });
		fireEvent.click(screen.getByTestId("curate-select-all"));
		fireEvent.click(screen.getByTestId("curate-bulk-hide"));
		expect(screen.getByTestId("curate-pop-p1")).toHaveProperty(
			"dataset.held",
			"true",
		);
		expect(screen.getByTestId("curate-pop-p2")).toHaveProperty(
			"dataset.held",
			"true",
		);
		fireEvent.click(screen.getByTestId("curate-bulk-show"));
		expect(screen.getByTestId("curate-pop-p1").dataset.held).toBeUndefined();
	});

	it("lets the ticks go when the tab changes", () => {
		show({ items: [pop(1), stakeholder] });
		fireEvent.click(screen.getByTestId("curate-pick-p1"));
		expect(screen.getByTestId("curate-bulk")).toBeTruthy();
		fireEvent.click(screen.getByTestId("curate-tab-stakeholders"));
		expect(screen.queryByTestId("curate-bulk")).toBeNull();
	});
});

describe("What the panel says when there is nothing to read", () => {
	it("waits in the shape of the table, never on a spinner", () => {
		show({ loading: true });
		expect(screen.getByTestId("curate-loading")).toBeTruthy();
		expect(screen.queryByRole("progressbar")).toBeNull();
	});

	it("says a tab is empty in its own words", () => {
		show({ first: "tensions" });
		expect(
			screen.getByText(
				"No tensions yet. They appear after the first analysis.",
			),
		).toBeTruthy();
	});

	it("says a block is not in this presentation, and still lists it", () => {
		show({ blocks: ["popcorn"], first: "tensions", items: [tension] });
		expect(screen.getByText("Not in this presentation.")).toBeTruthy();
		expect(screen.getByText("Who pays for the waiting")).toBeTruthy();
	});
});

describe("The tabs themselves", () => {
	it("calls the third tab by what is in it", () => {
		show({ items: [pop(1)] });
		expect(screen.getByTestId("curate-tab-map").textContent).toContain(
			"Arguments",
		);
	});

	it("is a tablist whose panel is named by the tab it belongs to", () => {
		show({ items: [pop(1)] });
		const tab = screen.getByTestId("curate-tab-popcorn");
		const panel = screen.getByRole("tabpanel");
		expect(panel.getAttribute("aria-labelledby")).toBe(tab.id);
		expect(tab.getAttribute("aria-controls")).toBe(panel.id);
		// Only the tab being read is in the tab order; the arrows reach the rest.
		expect(tab.getAttribute("tabindex")).toBe("0");
		expect(
			screen.getByTestId("curate-tab-tensions").getAttribute("tabindex"),
		).toBe("-1");
	});

	it("walks with the arrows and reaches the ends with Home and End", () => {
		show({ items: [pop(1)] });
		const tabs = screen.getByTestId("curate-tabs");
		fireEvent.keyDown(tabs, { key: "End" });
		expect(
			screen
				.getByTestId("curate-tab-stakeholders")
				.getAttribute("aria-selected"),
		).toBe("true");
		fireEvent.keyDown(tabs, { key: "Home" });
		expect(
			screen.getByTestId("curate-tab-popcorn").getAttribute("aria-selected"),
		).toBe("true");
		fireEvent.keyDown(tabs, { key: "ArrowLeft" });
		expect(
			screen
				.getByTestId("curate-tab-stakeholders")
				.getAttribute("aria-selected"),
		).toBe("true");
	});
});
