// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AnalysisObject } from "@/components/analysis/hooks";
import { ResultsList, type ResultsListProps } from "./ResultsList";
import type { ResultActions } from "./useResultActions";

const actions: ResultActions = {
	editWords: vi.fn(),
	heldBackReasons: [],
	holdBack: null,
	isHeld: () => false,
	pending: false,
	showAgain: null,
	undoWords: vi.fn(),
};

const phrase = (index: number): AnalysisObject => ({
	objectId: `pop-${index}`,
	payload: { phrase: `Phrase ${index}` },
	revisionId: `rev-${index}`,
	type: "popcorn",
});

const tension: AnalysisObject = {
	objectId: "ten-1",
	payload: { poleA: "Open longer", poleB: "Pay people" },
	revisionId: "rev-t",
	type: "tension",
};

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

function show(props: Partial<ResultsListProps> = {}) {
	return render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<ResultsList
					actions={actions}
					canEdit
					density="curate"
					items={[phrase(1), tension]}
					onOpen={() => {}}
					renderItem={() => null}
					{...props}
				/>
			</MantineProvider>
		</I18nProvider>,
	);
}

describe("the list", () => {
	it("groups by kind with the count beside the header", () => {
		show({ counts: { popcorn: 42, tension: 1 } });
		expect(screen.getByRole("heading", { name: "Popcorn 42" })).toBeTruthy();
		expect(screen.getByRole("heading", { name: "Tensions 1" })).toBeTruthy();
		expect(screen.getByText("Phrase 1")).toBeTruthy();
	});

	it("says so where there is nothing to read yet", () => {
		show({ items: [] });
		expect(screen.getByTestId("results-empty").textContent).toContain(
			"No findings yet",
		);
	});

	it("does not blame the analysis when a search finds nothing", () => {
		show({
			density: "check",
			filter: {
				kind: null,
				onChange: vi.fn(),
				query: "zebra",
				status: "active",
			},
		});
		expect(screen.getByTestId("results-empty").textContent).toBe(
			"No findings match.",
		);
	});

	it("shows twenty of a long group, then all of it in place", () => {
		const many = Array.from({ length: 25 }, (_, index) => phrase(index));
		show({ items: many });
		expect(screen.queryByText("Phrase 24")).toBeNull();
		fireEvent.click(screen.getByTestId("results-show-all-popcorn"));
		expect(screen.getByText("Phrase 24")).toBeTruthy();
	});

	it("counts what the server holds, not the page, and asks for the rest", () => {
		const onLoadMore = vi.fn();
		const page = Array.from({ length: 50 }, (_, index) => phrase(index));
		show({ counts: { popcorn: 140 }, items: page, onLoadMore });
		// Everything is reachable, and the way to it says how much there is.
		expect(
			screen.getByTestId("results-show-all-popcorn").textContent,
		).toContain("140");
		expect(screen.queryByText("Phrase 20")).toBeNull();
		// The first page holds more than the twenty at rest: nothing is asked for
		// until the host opens the group.
		expect(onLoadMore).not.toHaveBeenCalled();

		fireEvent.click(screen.getByTestId("results-show-all-popcorn"));
		expect(onLoadMore).toHaveBeenCalledWith(["popcorn"]);
		// Opened, the button is gone and no numbered pager takes its place.
		expect(screen.queryByTestId("results-show-all-popcorn")).toBeNull();
	});

	it("asks for the risen rows and twenty, where a page holds fewer", () => {
		const onLoadMore = vi.fn();
		const risen = Array.from({ length: 15 }, (_, index) => ({
			...phrase(index),
			attention: "new" as const,
		}));
		show({ counts: { popcorn: 140 }, items: risen, onLoadMore });
		expect(onLoadMore).toHaveBeenCalledWith(["popcorn"]);
	});

	it("waits for a page in the row's own skeleton, and asks once", () => {
		const onLoadMore = vi.fn();
		const page = Array.from({ length: 30 }, (_, index) => phrase(index));
		const { rerender } = show({
			counts: { popcorn: 140 },
			items: page,
			onLoadMore,
		});
		fireEvent.click(screen.getByTestId("results-show-all-popcorn"));
		expect(onLoadMore).toHaveBeenCalledTimes(1);
		rerender(
			<I18nProvider i18n={i18n}>
				<MantineProvider>
					<ResultsList
						actions={actions}
						canEdit
						counts={{ popcorn: 140 }}
						density="curate"
						items={page}
						loadingTypes={["popcorn"]}
						onLoadMore={onLoadMore}
						onOpen={() => {}}
						renderItem={() => null}
					/>
				</MantineProvider>
			</I18nProvider>,
		);
		expect(screen.getByTestId("results-loading-popcorn")).toBeTruthy();
		// The same page is not asked for twice while it is on its way.
		expect(onLoadMore).toHaveBeenCalledTimes(1);
	});

	it("stops asking once it holds everything the count promised", () => {
		const onLoadMore = vi.fn();
		const all = Array.from({ length: 25 }, (_, index) => phrase(index));
		show({ counts: { popcorn: 25 }, items: all, onLoadMore });
		fireEvent.click(screen.getByTestId("results-show-all-popcorn"));
		expect(onLoadMore).not.toHaveBeenCalled();
		expect(screen.getByText("Phrase 24")).toBeTruthy();
	});

	it("shows nothing as new on a first visit, and no rule", () => {
		show();
		expect(screen.queryByTestId("results-rule")).toBeNull();
		expect(screen.queryByText("new")).toBeNull();
	});

	it("lifts the rows the server marked, above one rule", () => {
		show({
			items: [
				phrase(1),
				{ ...phrase(2), attention: "new" },
				{ ...phrase(3), attention: "reworded", attentionActor: "Anna" },
			],
		});
		expect(screen.getByText("new")).toBeTruthy();
		expect(screen.getByText("Anna reworded this")).toBeTruthy();
		const rows = [...screen.getByRole("list").children].map(
			(row) => row.textContent ?? "",
		);
		// The two that rose lead, then the rule, then the rest.
		expect(rows[0]).toContain("Phrase 2");
		expect(rows[1]).toContain("Phrase 3");
		expect(rows[2]).toBe("");
		expect(rows[3]).toContain("Phrase 1");
		expect(screen.getByTestId("results-rule")).toBeTruthy();
	});

	it("keeps a row's place once the list is open", () => {
		const risen = { ...phrase(2), attention: "new" as const };
		const { rerender } = show({ items: [phrase(1), risen] });
		rerender(
			<I18nProvider i18n={i18n}>
				<MantineProvider>
					<ResultsList
						actions={actions}
						canEdit
						density="curate"
						items={[phrase(1), { ...risen, attention: null }]}
						onOpen={() => {}}
						renderItem={() => null}
					/>
				</MantineProvider>
			</I18nProvider>,
		);
		const rows = [...screen.getByRole("list").children].map(
			(row) => row.textContent ?? "",
		);
		// The phrase lost its word, not its place.
		expect(rows[0]).toContain("Phrase 2");
		expect(screen.queryByText("new")).toBeNull();
	});

	it("puts the filter row in the check density and nowhere else", () => {
		const filter = {
			kind: null,
			onChange: vi.fn(),
			query: "",
			status: "active",
		};
		show({ filter });
		expect(screen.queryByTestId("results-filters")).toBeNull();
		cleanup();

		show({ density: "check", filter });
		expect(screen.getByTestId("results-filters")).toBeTruthy();
		fireEvent.change(screen.getByRole("searchbox"), {
			target: { value: "Phrase 1" },
		});
		expect(filter.onChange).toHaveBeenCalledWith({ query: "Phrase 1" });
	});

	it("collapses a group whose block is off in this presentation", () => {
		show({ groupsOff: ["tension"] });
		expect(screen.getByRole("heading", { name: "Tensions 1" })).toBeTruthy();
		expect(screen.getByText("not in this presentation")).toBeTruthy();
		expect(screen.queryByText("Open longer")).toBeNull();
	});
});
