// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { EvidenceGroup } from "../data/adapter";
import {
	createMapInteractionStore,
	MapInteractionProvider,
} from "../state/interactionStore";
import type { Edge, MapGraphNode } from "../types";
import { ArgumentAccordion, AT_REST } from "./ArgumentAccordion";

beforeAll(() => {
	i18n.load("en-US", {});
	i18n.activate("en-US");
});

afterEach(cleanup);

const argument = (
	id: string,
	label: string,
	metadata: Partial<MapGraphNode["metadata"]> = {},
): MapGraphNode => ({
	embedding: [1, 0],
	id,
	label,
	metadata: {
		conversationIds: [],
		createdAt: null,
		kind: "argument",
		objectId: id,
		objectType: "argument",
		quotes: [],
		revisionId: id,
		sizeScale: 1,
		...metadata,
	},
});

// A star: "hub" sits between every leaf, so it is the most central.
const nodes = [
	argument("leaf-a", "The buses do not come"),
	argument("hub", "The timetable is the problem", {
		consolidation: { memberCount: 4 },
		valence: "negative",
	}),
	argument("leaf-b", "The station is too far", {
		factCheck: {
			checkedAt: "2026-09-01T00:00:00.000Z",
			justification: "",
			sources: [],
			status: "done",
			verdict: "false",
		},
	}),
	argument("leaf-c", "The fare went up"),
];

const edges: Edge[] = [
	{ distance: 0.2, source: "hub", target: "leaf-a" },
	{ distance: 0.3, source: "hub", target: "leaf-b" },
	{ distance: 0.4, source: "hub", target: "leaf-c" },
];

const evidence: Record<string, EvidenceGroup[]> = {
	hub: [
		{
			conversationId: "c1",
			label: "Conversation one",
			quotes: ["It is the timetable, nothing else."],
		},
	],
};

const Providers = ({
	children,
	store,
}: {
	children: ReactNode;
	store: ReturnType<typeof createMapInteractionStore>;
}) => (
	<I18nProvider i18n={i18n}>
		<MapInteractionProvider store={store}>{children}</MapInteractionProvider>
	</I18nProvider>
);

const renderList = (
	options: {
		store?: ReturnType<typeof createMapInteractionStore>;
		nodes?: MapGraphNode[];
		evidence?: Record<string, EvidenceGroup[]>;
	} = {},
) => {
	const store = options.store ?? createMapInteractionStore();
	render(
		<Providers store={store}>
			<ArgumentAccordion
				nodes={options.nodes ?? nodes}
				mstEdges={edges}
				evidenceFor={(id) => (options.evidence ?? evidence)[id] ?? []}
			/>
		</Providers>,
	);
	return store;
};

describe("the arguments under the map", () => {
	it("ranks by centrality in the tree", () => {
		renderList();
		const rows = screen
			.getAllByTestId(/^map-argument-row-/)
			.map((row) => row.getAttribute("data-testid"));
		expect(rows[0]).toBe("map-argument-row-hub");
		// The leaves are all equally far out, so they keep the order they came in.
		expect(rows.slice(1)).toEqual([
			"map-argument-row-leaf-a",
			"map-argument-row-leaf-b",
			"map-argument-row-leaf-c",
		]);
	});

	it("says what a row is made of in words", () => {
		renderList();
		expect(screen.getByText("against")).toBeTruthy();
		expect(screen.getByText("combined from 4")).toBeTruthy();
		expect(screen.getByText("Likely false")).toBeTruthy();
		expect(screen.getByText("1 quote · 1 conversation")).toBeTruthy();
	});

	it("opens the row of the node the map selects, with its quotes", () => {
		const store = createMapInteractionStore();
		renderList({ store });
		expect(screen.queryByText("Neighbours in the tree")).toBeNull();

		act(() => store.setSelectedNodeId("hub"));
		expect(screen.getByText("Neighbours in the tree")).toBeTruthy();
		expect(screen.getByText("It is the timetable, nothing else.")).toBeTruthy();
		expect(screen.getByTestId("map-argument-neighbour-leaf-a")).toBeTruthy();
	});

	it("jumps to a neighbour and selects it on the map", () => {
		const store = createMapInteractionStore({ selectedNodeId: "hub" });
		renderList({ store });
		fireEvent.click(screen.getByTestId("map-argument-neighbour-leaf-b"));
		expect(store.getState().selectedNodeId).toBe("leaf-b");
		// The neighbour's own row is the one that is open now, and it offers the
		// way back.
		expect(screen.getByTestId("map-argument-neighbour-hub")).toBeTruthy();
	});

	it("selects the node on the map when a row is opened", () => {
		const store = renderList();
		fireEvent.click(screen.getByTestId("map-argument-row-leaf-c"));
		expect(store.getState().selectedNodeId).toBe("leaf-c");
		fireEvent.click(screen.getByTestId("map-argument-row-leaf-c"));
		expect(store.getState().selectedNodeId).toBeNull();
	});

	it("says nothing about quotes where the payload carries none", () => {
		const store = createMapInteractionStore({ selectedNodeId: "hub" });
		renderList({ evidence: {}, store });
		expect(screen.getByText("Neighbours in the tree")).toBeTruthy();
		expect(screen.queryByText("Quotes")).toBeNull();
	});

	it("shows a page and opens the rest in place", () => {
		const many = Array.from({ length: AT_REST + 5 }, (_value, index) =>
			argument(`n-${index}`, `Argument ${index}`),
		);
		renderList({ evidence: {}, nodes: many });
		expect(screen.getAllByTestId(/^map-argument-row-/).length).toBe(AT_REST);
		fireEvent.click(screen.getByTestId("map-arguments-show-all"));
		expect(screen.getAllByTestId(/^map-argument-row-/).length).toBe(
			many.length,
		);
	});
});
