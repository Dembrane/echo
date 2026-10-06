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
import type { CSSProperties } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvidenceGroup, MapGraphData } from "../data/adapter";
import { buildMapGraph } from "../data/adapter";
import { FIXTURE_BUDGETS } from "../data/fixture";
import { createSyntheticPayload } from "../fixtures/syntheticMap";
import type { MapGroupDoc } from "../hooks";
import { MAP_DARK_VARS, MapExperience } from "../MapExperience";
import {
	createMapInteractionStore,
	MapInteractionProvider,
} from "../state/interactionStore";
import { DEFAULT_MAP_SETTINGS } from "../state/settings";
import type { MapGraphNode } from "../types";
import { KnowledgeGraph, knowledgeGraph } from "./KnowledgeGraph";

vi.mock("../layout/useMapGeometry", () => ({
	EMPTY_EDGES: [],
	useMapGeometry: () => ({
		mstEdges: [],
		neighbours: { fpLinks: [], nnLinks: [] },
		status: "ready",
	}),
}));
vi.mock("../renderers/MstGraph", () => ({
	DEFAULT_WALK_INTERVAL_MS: 30_000,
	MstMap: () => <div>Tree renderer</div>,
}));
vi.mock("../renderers/LocalMapGraph", () => ({
	LocalMap: () => <div>Cluster renderer</div>,
}));

i18n.load("en-US", {});
i18n.activate("en-US");

beforeEach(() => {
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	vi.stubGlobal(
		"matchMedia",
		vi.fn(() => ({
			addEventListener: vi.fn(),
			matches: false,
			removeEventListener: vi.fn(),
		})),
	);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const group = (
	conversationId: string,
	label: string,
	slot: number,
	quotes: string[],
): EvidenceGroup => ({ conversationId, label, quotes, slot });

/**
 * Three arguments. The first has four quotes over two conversations, the
 * second one quote, the third none. A cluster holds the first two.
 */
const makeGraph = (): MapGraphData => {
	const { payload } = createSyntheticPayload({
		budgets: FIXTURE_BUDGETS,
		counts: { argument: 3 },
	});
	const graph = buildMapGraph(payload);
	const [a, b, c] = graph.placedNodes;
	graph.evidenceById = new Map([
		[
			a.id,
			[
				group("conv-ada", "Ada's table", 0, [
					"The crossing is the worst part.",
					"Cars never stop there.",
					"My kids walk it every morning.",
				]),
				group("conv-ben", "Ben's table", 1, ["Same at the other end."]),
			],
		],
		[b.id, [group("conv-ada", "Ada's table", 0, ["Bins overflow."])]],
		[c.id, []],
	]);
	return graph;
};

const clusterDoc = (graph: MapGraphData): MapGroupDoc => ({
	createdAt: "2026-10-07T10:00:00Z",
	error: null,
	id: "group-1",
	members: graph.placedNodes.slice(0, 2).map((node) => ({
		objectId: null,
		revisionId: node.id,
		type: "argument",
	})),
	snapshotId: graph.snapshotId,
	status: "ready",
	title: "Safer crossings near the school",
});

const renderMap = ({
	provenance = true,
	darkMode = false,
	rootStyle,
}: {
	provenance?: boolean;
	darkMode?: boolean;
	rootStyle?: CSSProperties;
} = {}) => {
	const graph = makeGraph();
	const store = createMapInteractionStore({
		selectedNodeId: graph.placedNodes[0].id,
	});
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<MemoryRouter>
				<I18nProvider i18n={i18n}>
					<MantineProvider>
						<div
							data-testid="themed-root"
							data-theme={darkMode ? "dark" : undefined}
							style={rootStyle}
						>
							<MapInteractionProvider store={store}>
								<MapExperience
									graph={graph}
									placedNodes={graph.placedNodes}
									visibleIds={new Set(graph.allNodes.map((node) => node.id))}
									budgets={{ edgeLimit: 100, nodeLimit: 100 }}
									colorBy="none"
									onColorByChange={() => {}}
									settings={{
										...DEFAULT_MAP_SETTINGS,
										darkMode,
										showClusters: true,
										showSpotlight: true,
									}}
									factCheckStates={{}}
									onFactCheck={() => {}}
									onCancelFactCheck={() => {}}
									canFactCheck={false}
									conversationHref={(id) => `/conversations/${id}`}
									offline={false}
									titles={false}
									provenance={provenance}
									groups={[clusterDoc(graph)]}
								/>
							</MapInteractionProvider>
						</div>
					</MantineProvider>
				</I18nProvider>
			</MemoryRouter>
		</QueryClientProvider>,
	);
	return graph;
};

const openCluster = async (from: RegExp) => {
	fireEvent.click(await screen.findByText("Safer crossings near the school"));
	fireEvent.click(await screen.findByRole("button", { name: from }));
	return screen.findByRole("dialog");
};

describe("the details sheet", () => {
	it("opens a cluster from Quotes with its count, and closes with Escape", async () => {
		renderMap();
		const sheet = await openCluster(/^Quotes \(5\)$/);
		expect(
			screen.getByRole("dialog", { name: "Safer crossings near the school" }),
		).toBe(sheet);
		expect(within(sheet).getByTestId("sheet-count").textContent).toBe(
			"From 5 quotes in 2 conversations",
		);
		// It sits inside the map, not in a portal over the page.
		expect(screen.getByTestId("themed-root").contains(sheet)).toBe(true);
		expect(within(sheet).getByRole("region", { name: "Quotes" })).toBeTruthy();

		fireEvent.keyDown(document, { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("opens a cluster from Connections on its graph, and closes from its button", async () => {
		renderMap();
		const sheet = await openCluster(/^Connections$/);
		expect(within(sheet).getByTestId("knowledge-graph")).toBeTruthy();
		fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("opens a single argument with its own quotes", async () => {
		const graph = renderMap();
		fireEvent.click(
			await screen.findByRole("button", { name: /^Quotes \(4\)$/ }),
		);
		const sheet = await screen.findByRole("dialog");
		expect(within(sheet).getByTestId("sheet-title").textContent).toBe(
			graph.placedNodes[0].label,
		);
		expect(within(sheet).getByTestId("sheet-count").textContent).toBe(
			"From 4 quotes in 2 conversations",
		);
	});

	it("shows the first two quotes of an argument, then all of them", async () => {
		const graph = renderMap();
		const sheet = await openCluster(/^Quotes \(5\)$/);
		const first = within(sheet)
			.getAllByRole("article")
			.find(
				(article) =>
					article.getAttribute("data-argument-id") === graph.placedNodes[0].id,
			) as HTMLElement;
		expect(within(first).getAllByRole("listitem")).toHaveLength(2);
		fireEvent.click(within(first).getByRole("button", { name: "Show all 4" }));
		expect(within(first).getAllByRole("listitem")).toHaveLength(4);
	});

	it("marks an argument's quotes when its node is picked, and one quote when its leaf is", async () => {
		const graph = renderMap();
		const sheet = await openCluster(/^Connections$/);
		const [a] = graph.placedNodes;
		const nodes = sheet.querySelectorAll<SVGGElement>(
			`[data-node-kind="argument"][data-node-id="${a.id}"]`,
		);
		fireEvent.click(nodes[0]);
		const marked = () =>
			[...sheet.querySelectorAll("[data-quote-id][data-selected]")].map(
				(element) => element.getAttribute("data-quote-id"),
			);
		expect(marked()).toEqual([`${a.id}#0`, `${a.id}#1`]);
		expect(within(sheet).getByTestId("graph-mark")).toBeTruthy();

		// The third quote is folded; picking its leaf opens the list on it.
		const leaf = sheet.querySelector<SVGGElement>(
			`[data-node-id="${a.id}#2"]`,
		) as SVGGElement;
		fireEvent.click(leaf);
		expect(marked()).toEqual([`${a.id}#2`]);
	});

	it("names a node under the graph when it is focused", async () => {
		renderMap();
		const sheet = await openCluster(/^Connections$/);
		const leaf = sheet.querySelector<SVGGElement>(
			'[data-node-kind="quote"]',
		) as SVGGElement;
		fireEvent.focus(leaf);
		expect(within(sheet).getByTestId("graph-caption").textContent).toContain(
			"The crossing is the worst part.",
		);
	});

	it("links each quote to its conversation on the Map page", async () => {
		renderMap();
		const sheet = await openCluster(/^Quotes \(5\)$/);
		const links = within(sheet).getAllByRole("link", { name: "Ada's table" });
		expect(links[0].getAttribute("href")).toContain("/conversations/conv-ada");
	});

	it("shows no conversation links in the room", async () => {
		renderMap({ provenance: false });
		const sheet = await openCluster(/^Quotes \(5\)$/);
		expect(within(sheet).queryAllByRole("link")).toHaveLength(0);
		// The conversation is still named, as the room names it.
		expect(within(sheet).getAllByText("Ada's table").length).toBeGreaterThan(0);
	});

	it("keeps the room's dark colours", async () => {
		renderMap({ darkMode: true, rootStyle: MAP_DARK_VARS });
		const sheet = await openCluster(/^Quotes \(5\)$/);
		// The map's own tokens, which the dark root relights, never a white.
		expect(sheet.style.backgroundColor).toBe("var(--map-surface-raised)");
		expect(sheet.style.color).toBe("var(--map-text)");
		expect(sheet.closest('[data-theme="dark"]')).not.toBeNull();
	});
});

describe("the knowledge graph", () => {
	const node = (id: string): MapGraphNode =>
		({
			embedding: [0, 1],
			id,
			label: `Argument ${id}`,
			metadata: {
				conversationIds: [],
				createdAt: null,
				kind: "argument",
				objectId: id,
				objectType: "argument",
				quotes: [],
				revisionId: id,
				sizeScale: 1,
			},
		}) as MapGraphNode;
	const nodesById = new Map(["a", "b", "c"].map((id) => [id, node(id)]));
	const evidence: Record<string, EvidenceGroup[]> = {
		a: [group("x", "X", 0, ["one", "two"]), group("y", "Y", 1, ["three"])],
		b: [group("x", "X", 0, ["four"])],
		c: [],
	};
	const graph = knowledgeGraph({
		edges: [{ distance: 0.4, source: "a", target: "b" }],
		evidenceFor: (id) => evidence[id] ?? [],
		expand: false,
		focusIds: ["a", "b", "c"],
		nodesById,
		relations: [
			{
				basis: "inferred",
				id: "r",
				source: "b",
				target: "c",
				type: "supports",
			},
		],
	});

	it("has one node per argument and one leaf per quote", () => {
		expect(graph.nodes.filter((n) => n.kind === "argument")).toHaveLength(3);
		expect(graph.nodes.filter((n) => n.kind === "quote")).toHaveLength(4);
		expect(graph.links.filter((l) => l.kind === "relation")).toEqual([
			{ kind: "relation", source: "b", target: "c" },
		]);
	});

	it("draws them, relations dashed", () => {
		render(
			<I18nProvider i18n={i18n}>
				<MantineProvider>
					<KnowledgeGraph
						graph={graph}
						nodesById={nodesById}
						colorBy="none"
						darkMode={false}
						marked={null}
						onPick={() => {}}
					/>
				</MantineProvider>
			</I18nProvider>,
		);
		const svg = screen.getByRole("group", { name: "Knowledge graph" });
		expect(svg.querySelectorAll('[data-node-kind="argument"]')).toHaveLength(3);
		expect(svg.querySelectorAll('[data-node-kind="quote"]')).toHaveLength(4);
		const relation = svg.querySelector('[data-link="relation"]');
		expect(relation?.getAttribute("stroke-dasharray")).toBeTruthy();
		expect(relation?.getAttribute("stroke-width")).toBe("1");
	});
});
