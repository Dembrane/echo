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
import { useResultFeedback } from "../feedback/useResultFeedback";
import type { ResultActions } from "../useResultActions";
import { ArgumentsTab, filterArguments, sortArguments } from "./ArgumentsTab";
import { useSelection } from "./useSelection";

vi.mock("@/lib/bff", () => ({
	bff: {
		delete: vi.fn().mockResolvedValue({ myFeedback: null }),
		get: vi.fn().mockResolvedValue({ revisions: [] }),
		post: vi.fn(),
		put: vi.fn().mockResolvedValue({ myFeedback: null }),
	},
}));

const argument = (
	objectId: string,
	statement: string,
	valence: "positive" | "negative",
	who: string,
	extra: Partial<AnalysisObject> = {},
): AnalysisObject =>
	({
		detail: {
			evidence: [
				{ conversationId: who, label: who, quotes: [`${who} said so.`] },
			],
		},
		objectId,
		payload: { statement, valence },
		revisionId: `rev-${objectId}`,
		type: "argument",
		...extra,
	}) as AnalysisObject;

const items = [
	argument("a1", "The buses run late", "negative", "Wim"),
	argument("a2", "The library is warm", "positive", "Ada", {
		verdict: "false",
	}),
	argument("a3", "The market is loud", "negative", "Ada", {
		type: "deduplicated_argument",
	}),
];

/** A stand-in for the panel's own adapter: the decision is kept in state, so
    the row dims the way it does on the page. */
function useTestActions(): ResultActions {
	const [held, setHeld] = useState<string[]>([]);
	return {
		editWords: vi.fn(),
		heldBackReasons: [],
		heldReason: () => undefined,
		holdBack: (objectId: string) =>
			setHeld((old) => [...new Set([...old, objectId])]),
		holdBackMany: () => {},
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

function Table({ onNeedsAll }: { onNeedsAll: () => void }) {
	const actions = useTestActions();
	const feedback = useResultFeedback("project");
	const selection = useSelection();
	return (
		<ArgumentsTab
			actions={actions}
			analysisHref="/analysis"
			canEdit
			feedback={feedback}
			items={items}
			selection={selection}
			onNeedsAll={onNeedsAll}
			onOpen={() => {}}
			openObjectId={null}
			projectId="project"
			total={146}
		/>
	);
}

function show(onNeedsAll = () => {}) {
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
	});
	render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={client}>
				<MantineProvider>
					<MemoryRouter>
						<Table onNeedsAll={onNeedsAll} />
					</MemoryRouter>
				</MantineProvider>
			</QueryClientProvider>
		</I18nProvider>,
	);
}

describe("Sorting and filtering the map arguments", () => {
	it("sorts by stance, by conversation and by fact-check, both ways", () => {
		const byStance = sortArguments(items, {
			ascending: true,
			column: "stance",
		});
		expect(byStance.map((item) => item.objectId)).toEqual(["a1", "a3", "a2"]);
		const back = sortArguments(items, { ascending: false, column: "stance" });
		expect(back.map((item) => item.objectId)).toEqual(["a2", "a1", "a3"]);
		const byWho = sortArguments(items, {
			ascending: true,
			column: "conversation",
		});
		expect(byWho.map((item) => item.objectId)).toEqual(["a2", "a3", "a1"]);
		const byCheck = sortArguments(items, {
			ascending: false,
			column: "factCheck",
		});
		expect(byCheck[0].objectId).toBe("a2");
	});

	it("leaves the server's attention order alone until a column is asked for", () => {
		expect(sortArguments(items, null)).toBe(items);
	});

	it("searches the statement and the conversation, and filters by stance", () => {
		expect(
			filterArguments(items, {
				conversation: "",
				query: "buses",
				stance: "all",
			}).map((item) => item.objectId),
		).toEqual(["a1"]);
		expect(
			filterArguments(items, {
				conversation: "",
				query: "",
				stance: "for",
			}).map((item) => item.objectId),
		).toEqual(["a2"]);
		expect(
			filterArguments(items, {
				conversation: "Ada",
				query: "",
				stance: "all",
			}).map((item) => item.objectId),
		).toEqual(["a2", "a3"]);
	});
});

describe("The map arguments table", () => {
	it("is a table with sortable headers and the stance in words", () => {
		show();
		expect(screen.getByRole("table")).toBeTruthy();
		expect(
			screen.getAllByRole("columnheader").map((head) => head.textContent),
		).toEqual(["", "Statement", "Stance", "Source", "Fact-check", "Tools"]);
		// The stance filter says the same two words above the table.
		expect(screen.getAllByText("for").length).toBe(2);
		expect(screen.getAllByText("against").length).toBe(3);
		// Only a verdict that disagrees is said as a sentence.
		expect(screen.getByText("the fact-check disagrees")).toBeTruthy();
	});

	it("says which way a column is sorted, and turns it round on a second click", () => {
		show();
		const stance = screen.getByTestId("curate-sort-stance");
		expect(stance.closest("th")?.getAttribute("aria-sort")).toBe("none");
		fireEvent.click(stance);
		expect(stance.closest("th")?.getAttribute("aria-sort")).toBe("ascending");
		fireEvent.click(stance);
		expect(stance.closest("th")?.getAttribute("aria-sort")).toBe("descending");
	});

	it("asks for the pages it does not hold before it honours a sort or a filter", () => {
		const asked = vi.fn();
		show(asked);
		fireEvent.click(screen.getByTestId("curate-sort-conversation"));
		expect(asked).toHaveBeenCalled();
		asked.mockClear();
		fireEvent.click(screen.getByTestId("curate-stance-for"));
		expect(asked).toHaveBeenCalled();
	});

	it("counts what is shown against the whole, and narrows on a filter", () => {
		show();
		expect(screen.getByTestId("curate-argument-count").textContent).toBe(
			"3 of 146",
		);
		fireEvent.click(screen.getByTestId("curate-stance-for"));
		expect(screen.getByTestId("curate-argument-count").textContent).toBe(
			"1 of 146",
		);
		expect(screen.queryByText("The buses run late")).toBeNull();
	});

	it("says 'combined' after a deduplicated argument's words, in soft ink", () => {
		show();
		expect(screen.getByText("combined")).toBeTruthy();
	});

	it("hides a row in one click and greys it where it stands", () => {
		show();
		fireEvent.click(
			screen.getAllByRole("button", {
				name: "Hide from this presentation",
			})[0],
		);
		expect(screen.getByTestId("curate-argument-a1")).toHaveProperty(
			"dataset.held",
			"true",
		);
	});
});
