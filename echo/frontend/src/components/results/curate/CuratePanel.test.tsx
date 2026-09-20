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
	bff: { get: vi.fn().mockResolvedValue({ revisions: [] }), post: vi.fn() },
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

describe("The shape each tab takes", () => {
	it("gives popcorn one line per phrase, with the conversation beside it", () => {
		show({ items: [pop(1)] });
		expect(screen.getByText("phrase 1")).toBeTruthy();
		expect(screen.getByText("Conversation 1")).toBeTruthy();
		// A popcorn is its own quote: no "1 quote from …" line under every row.
		expect(screen.queryByText(/quote from/)).toBeNull();
	});

	it("opens a popcorn on the sentence it was cut from, phrase marked", () => {
		show({ items: [pop(1)] });
		fireEvent.click(screen.getByTestId("curate-pop-p1"));
		const quote = screen.getByTestId("curate-quote");
		expect(quote.textContent).toContain("And then phrase 1 came up");
		expect(quote.querySelector("span")?.textContent).toBe("phrase 1");
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

	it("gives a tension an open card, its quotes under the pole they stand for", () => {
		show({ first: "tensions", items: [tension] });
		expect(screen.getByText("Who pays for the waiting")).toBeTruthy();
		expect(screen.getByText("Whether the budget stretches")).toBeTruthy();
		// No caret and no accordion: the evidence is on the face of the card.
		expect(screen.getByTestId("curate-poles")).toBeTruthy();
		expect(screen.getByText("Stay open past six.")).toBeTruthy();
		expect(screen.getByText("Pay us for the hours.")).toBeTruthy();
		expect(screen.getByText("History / details")).toBeTruthy();
	});

	it("gives stakeholders a short table, with the rung only when it is not voiced", () => {
		show({ first: "stakeholders", items: [stakeholder] });
		expect(
			screen.getAllByRole("columnheader").map((head) => head.textContent),
		).toEqual(["Name", "Role", "Stake", "How they were named", "Hide"]);
		expect(screen.getByText("Night shift staff")).toBeTruthy();
		expect(screen.getByText("Inferred")).toBeTruthy();
	});
});

describe("What the panel says when there is nothing to read", () => {
	it("waits in the shape of the tab, never on a spinner", () => {
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
