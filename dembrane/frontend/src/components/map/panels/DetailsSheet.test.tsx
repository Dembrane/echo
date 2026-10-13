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
import { type Focus, TRAIL_STEPS, travelTo } from "./DetailsSheet";
import { KnowledgeGraph, knowledgeGraph } from "./KnowledgeGraph";

// The tree the sheet reads, set per test; one array, so a render keeps it.
const geometry = vi.hoisted(() => ({
	mstEdges: [] as Array<{ source: string; target: string; distance: number }>,
	neighbours: { fpLinks: [], nnLinks: [] },
}));
vi.mock("../layout/useMapGeometry", () => ({
	EMPTY_EDGES: [],
	useMapGeometry: () => ({
		mstEdges: geometry.mstEdges,
		neighbours: geometry.neighbours,
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
	geometry.mstEdges = [];
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
	// The first argument supports the second.
	graph.relations = [
		{
			basis: "inferred",
			id: "rel-ab",
			source: a.id,
			target: b.id,
			type: "supports",
		},
	];
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
	const view = render(
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
	return { graph, store, view };
};

/** A dot in the sheet's graph: an argument by its id, a quote by `id#n`. */
const dot = (sheet: HTMLElement, id: string) => {
	const found = [...sheet.querySelectorAll<SVGGElement>("[data-node-id]")].find(
		(element) => element.getAttribute("data-node-id") === id,
	);
	if (!found) throw new Error(`No dot ${id} in the graph`);
	return found;
};

/** The trail's steps as read. */
const trail = (sheet: HTMLElement) =>
	[
		...within(sheet)
			.getByTestId("sheet-trail")
			.querySelectorAll("button, [aria-current]"),
	].map((step) => step.textContent);

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
		const { graph } = renderMap();
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
		const { graph } = renderMap();
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

	it("travels to an argument picked in a cluster's graph, and marks one quote when its leaf is", async () => {
		const { graph } = renderMap();
		const sheet = await openCluster(/^Connections$/);
		const [a] = graph.placedNodes;
		fireEvent.click(dot(sheet, a.id));
		expect(within(sheet).getByTestId("sheet-focus-title").textContent).toBe(
			a.label,
		);
		// The focus is ringed in the middle of the graph.
		expect(dot(sheet, a.id).getAttribute("aria-current")).toBe("true");
		expect(within(sheet).getByTestId("graph-mark")).toBeTruthy();
		const marked = () =>
			[...sheet.querySelectorAll("[data-quote-id][data-selected]")].map(
				(element) => element.getAttribute("data-quote-id"),
			);
		expect(marked()).toEqual([]);

		// The third quote is folded; picking its leaf opens the list on it and
		// stays on the same argument.
		fireEvent.click(dot(sheet, `${a.id}#2`));
		expect(marked()).toEqual([`${a.id}#2`]);
		expect(
			within(sheet).getByText("My kids walk it every morning."),
		).toBeTruthy();
		expect(within(sheet).getByTestId("sheet-focus-title").textContent).toBe(
			a.label,
		);
	});

	it("goes on to a neighbour picked in the graph, with its quotes under it", async () => {
		const { graph } = renderMap();
		const [a, b] = graph.placedNodes;
		fireEvent.click(
			await screen.findByRole("button", { name: /^Quotes \(4\)$/ }),
		);
		const sheet = await screen.findByRole("dialog");
		const panel = within(sheet).getByTestId("sheet-panel");
		expect(
			within(panel).getByText("The crossing is the worst part."),
		).toBeTruthy();

		fireEvent.click(dot(sheet, b.id));
		expect(within(sheet).getByTestId("sheet-focus-title").textContent).toBe(
			b.label,
		);
		expect(within(panel).getByText("Bins overflow.")).toBeTruthy();
		expect(
			within(panel).queryByText("The crossing is the worst part."),
		).toBeNull();
		// Its relationship back is the dashed list, and it travels too.
		fireEvent.click(within(panel).getByTestId(`sheet-relation-${a.id}`));
		expect(within(sheet).getByTestId("sheet-focus-title").textContent).toBe(
			a.label,
		);
	});

	it("keeps clicking through the tree's neighbours", async () => {
		const { graph: first } = renderMap();
		cleanup();
		const [a, b, c] = first.placedNodes;
		geometry.mstEdges = [{ distance: 0.3, source: b.id, target: c.id }];
		renderMap();
		fireEvent.click(
			await screen.findByRole("button", { name: /^Quotes \(4\)$/ }),
		);
		const sheet = await screen.findByRole("dialog");
		fireEvent.click(dot(sheet, b.id));
		// From the second argument its tree neighbour is one click on.
		fireEvent.click(dot(sheet, c.id));
		expect(within(sheet).getByTestId("sheet-focus-title").textContent).toBe(
			c.label,
		);
		expect(
			within(sheet).getByText("No quotes for this argument."),
		).toBeTruthy();
		expect(trail(sheet)).toEqual([a.label, b.label, c.label]);
	});

	it("shows the path in the trail and travels back along it", async () => {
		const { graph } = renderMap();
		const [a, b] = graph.placedNodes;
		const sheet = await openCluster(/^Connections$/);
		// At the cluster there is nowhere to go back to.
		expect(within(sheet).queryByTestId("sheet-trail")).toBeNull();

		fireEvent.click(dot(sheet, a.id));
		fireEvent.click(dot(sheet, b.id));
		expect(trail(sheet)).toEqual([
			"Safer crossings near the school",
			a.label,
			b.label,
		]);
		const path = within(sheet).getByRole("navigation", { name: "Trail" });
		// The step you are on is not a button.
		expect(within(path).getAllByRole("button")).toHaveLength(2);

		fireEvent.click(within(path).getByRole("button", { name: a.label }));
		expect(within(sheet).getByTestId("sheet-focus-title").textContent).toBe(
			a.label,
		);
		expect(trail(sheet)).toEqual(["Safer crossings near the school", a.label]);

		fireEvent.click(
			within(sheet).getByRole("button", {
				name: "Safer crossings near the school",
			}),
		);
		expect(within(sheet).getByTestId("sheet-cluster")).toBeTruthy();
		expect(within(sheet).queryByTestId("sheet-trail")).toBeNull();
	});

	it("keeps the trail to the last steps, the item it opened on first", () => {
		const step = (id: string): Focus => ({ id, kind: "argument" });
		let path: Focus[] = [{ kind: "cluster" }];
		for (const id of ["a", "b", "c", "d", "e"]) path = travelTo(path, step(id));
		expect(path).toHaveLength(TRAIL_STEPS);
		expect(path).toEqual([
			{ kind: "cluster" },
			step("c"),
			step("d"),
			step("e"),
		]);
		// Going to a step on the trail goes back to it.
		expect(travelTo(path, step("d"))).toEqual([
			{ kind: "cluster" },
			step("c"),
			step("d"),
		]);
	});

	it("scrolls nothing on a click, not the sheet and not the page", async () => {
		const scrollIntoView = vi.fn();
		const scrollTo = vi.fn();
		Element.prototype.scrollIntoView = scrollIntoView;
		Element.prototype.scrollTo = scrollTo as unknown as Element["scrollTo"];
		vi.stubGlobal("scrollTo", scrollTo);
		try {
			const { graph } = renderMap();
			const [a, b] = graph.placedNodes;
			const sheet = await openCluster(/^Connections$/);
			fireEvent.click(dot(sheet, a.id));
			fireEvent.click(dot(sheet, `${a.id}#2`));
			fireEvent.click(dot(sheet, b.id));
			fireEvent.click(
				within(sheet).getByRole("button", {
					name: "Safer crossings near the school",
				}),
			);
			expect(scrollIntoView).not.toHaveBeenCalled();
			expect(scrollTo).not.toHaveBeenCalled();
			expect(within(sheet).getByTestId("sheet-scroll").scrollTop).toBe(0);
			let ancestor: HTMLElement | null = sheet.parentElement;
			while (ancestor) {
				expect(ancestor.scrollTop).toBe(0);
				ancestor = ancestor.parentElement;
			}
		} finally {
			delete (Element.prototype as Partial<Element>).scrollIntoView;
			delete (Element.prototype as Partial<Element>).scrollTo;
		}
	});

	it("opens a cluster from Arguments on its arguments, and All quotes groups them", async () => {
		const { graph } = renderMap();
		const [a, b] = graph.placedNodes;
		const sheet = await openCluster(/^Arguments \(2\)$/);
		const cluster = within(sheet).getByTestId("sheet-cluster");
		expect(within(cluster).getByTestId("sheet-count").textContent).toBe(
			"From 5 quotes in 2 conversations",
		);
		// Each argument with its first quote, to pick from the list too.
		expect(
			within(cluster).getByTestId(`sheet-argument-${a.id}`).textContent,
		).toContain("The crossing is the worst part.");
		expect(within(cluster).queryByTestId("sheet-all-quotes")).toBeNull();

		const all = within(cluster).getByRole("button", { name: "All quotes" });
		fireEvent.click(all);
		expect(all.getAttribute("aria-pressed")).toBe("true");
		const grouped = within(cluster).getByTestId("sheet-all-quotes");
		expect(
			[...grouped.querySelectorAll("article")].map((article) =>
				article.getAttribute("data-argument-id"),
			),
		).toEqual([a.id, b.id]);
		expect(within(grouped).getByText("Bins overflow.")).toBeTruthy();

		// Picking from the list travels like a dot does.
		fireEvent.click(all);
		fireEvent.click(within(cluster).getByTestId(`sheet-argument-${b.id}`));
		expect(within(sheet).getByTestId("sheet-focus-title").textContent).toBe(
			b.label,
		);
	});

	it("marks the travelled argument on the main map, and moves no selection", async () => {
		const { graph, store } = renderMap();
		const [a, b] = graph.placedNodes;
		fireEvent.click(
			await screen.findByRole("button", { name: /^Quotes \(4\)$/ }),
		);
		const sheet = await screen.findByRole("dialog");
		const revision = store.getState().selectionRevision;
		fireEvent.click(dot(sheet, b.id));
		const state = store.getState();
		expect([...state.highlightedNodeIds]).toEqual([b.id]);
		expect(state.highlightSource).toBe("history");
		expect(state.selectedNodeId).toBe(a.id);
		expect(state.selectionRevision).toBe(revision);
		// Spotlight still shows what the sheet was opened on, and so does the
		// sheet's own title.
		expect(within(sheet).getByTestId("sheet-title").textContent).toBe(a.label);

		fireEvent.keyDown(document, { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(store.getState().highlightedNodeIds.size).toBe(0);
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

	it("shows no conversation links in the room, and travels from the keyboard", async () => {
		const { graph } = renderMap({ provenance: false });
		const [a, b] = graph.placedNodes;
		const sheet = await openCluster(/^Quotes \(5\)$/);
		expect(within(sheet).queryAllByRole("link")).toHaveLength(0);
		// The conversation is still named, as the room names it.
		expect(within(sheet).getAllByText("Ada's table").length).toBeGreaterThan(0);

		// The dots take focus, and Enter travels.
		fireEvent.keyDown(dot(sheet, a.id), { key: "Enter" });
		expect(within(sheet).getByTestId("sheet-focus-title").textContent).toBe(
			a.label,
		);
		fireEvent.keyDown(dot(sheet, b.id), { key: "Enter" });
		expect(within(sheet).getByTestId("sheet-focus-title").textContent).toBe(
			b.label,
		);
		expect(dot(sheet, b.id).getAttribute("tabindex")).toBe("0");
		expect(within(sheet).queryAllByRole("link")).toHaveLength(0);
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
