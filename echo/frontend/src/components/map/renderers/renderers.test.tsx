// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { LEGACY_BUDGET_BOUNDS, minEdgeLimit } from "../budgets";
import { buildMapGraph } from "../data/adapter";
import { fixtureMapData } from "../data/fixture";
import { createSyntheticMap } from "../fixtures/syntheticMap";
import {
	createNearestNeighbourForce,
	fruchtermanReingoldK,
	MST_FORCE_DEFAULTS,
	mstLinkDistance,
} from "../graph/forces";
import {
	buildLocalMapForces,
	LOCAL_MAP_SEED,
	type LocalMapLink,
	seededRandom,
} from "../graph/localMap";
import { adjacencyOf, buildMST } from "../graph/mst";
import { nodeGeometryKey } from "../graph/nodeSet";
import { createRelationFixture } from "../layout/benchmark";
import { LayoutClient } from "../layout/client";
import { packVectors, runLayoutSync } from "../layout/compute";
import { orderNeighbourPairs, relationLines } from "../layout/edgeBudget";
import { registerGeometryResult } from "../layout/geometryResult";
import { FakeLayoutWorker, fakeWorkerFactory } from "../layout/testWorker";
import { useMapGeometry } from "../layout/useMapGeometry";
import {
	createMapInteractionStore,
	MapInteractionProvider,
	type MapInteractionStore,
} from "../state/interactionStore";
import type { ColorBy, MapGraphNode, MapRelation } from "../types";
import { AUTO_FIT_EVERY_TICKS } from "./autoFit";
import { d3, type Simulation, type SimulationNodeDatum } from "./d3";
import { LocalMap } from "./LocalMapGraph";
import { DEFAULT_WALK_INTERVAL_MS, MstMap } from "./MstGraph";

// Spies around the real implementations, to count MST builds and read the
// link distances and neighbour pairs the renderers ask for.
vi.mock("../graph/mst", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../graph/mst")>();
	return { ...actual, buildMST: vi.fn(actual.buildMST) };
});
vi.mock("../graph/forces", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../graph/forces")>();
	return {
		...actual,
		createNearestNeighbourForce: vi.fn(actual.createNearestNeighbourForce),
		mstLinkDistance: vi.fn(actual.mstLinkDistance),
	};
});

/** The deployment's default visible-edge budget. */
const { edgeLimit: EDGE_LIMIT } = LEGACY_BUDGET_BOUNDS.defaults;
// Records the simulations the renderers create, so tests can stop them and
// run their tick listeners by hand.
vi.mock("./d3", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./d3")>();
	return {
		...actual,
		d3: { ...actual.d3, forceSimulation: vi.fn(actual.d3.forceSimulation) },
	};
});

i18n.load("en-US", {});
i18n.activate("en-US");

type ResizeCallback = (
	entries: Array<{
		target: Element;
		contentRect: { width: number; height: number };
	}>,
) => void;

const resizeObservers = new Set<{
	callback: ResizeCallback;
	elements: Element[];
}>();

/** A ResizeObserver the tests drive by hand. */
class ResizeObserverStub {
	private readonly entry: { callback: ResizeCallback; elements: Element[] };

	constructor(callback: ResizeCallback) {
		this.entry = { callback, elements: [] };
		resizeObservers.add(this.entry);
	}

	observe(element: Element) {
		this.entry.elements.push(element);
	}

	unobserve() {}

	disconnect() {
		resizeObservers.delete(this.entry);
	}
}

const resizeContainers = (width: number, height: number) => {
	for (const { callback, elements } of [...resizeObservers]) {
		callback(
			elements.map((target) => ({ contentRect: { height, width }, target })),
		);
	}
};

beforeAll(() => {
	// MantineProvider reads the OS colour scheme; jsdom has no matchMedia.
	window.matchMedia =
		window.matchMedia ||
		((query: string) => ({
			addEventListener: () => {},
			addListener: () => {},
			dispatchEvent: () => false,
			matches: false,
			media: query,
			onchange: null,
			removeEventListener: () => {},
			removeListener: () => {},
		}));
	window.ResizeObserver =
		ResizeObserverStub as unknown as typeof window.ResizeObserver;
});

afterEach(cleanup);

const nodes = createSyntheticMap({ count: 20 });

type Datum = { id: string; x?: number; y?: number };
/** The datum d3 bound to an element. */
const datumOf = <T = Datum>(element: Element): T =>
	(element as Element & { __data__: T }).__data__;

const circleOf = (container: Element, id: string) =>
	Array.from(container.querySelectorAll("circle.node")).find(
		(circle) => datumOf(circle).id === id,
	) as Element;

const localSvgOf = (container: Element) =>
	container.querySelector(
		'svg[aria-label="Local argument map"]',
	) as SVGSVGElement;

/** Where a node sits on screen, through the map's current zoom. */
const screenPointOf = (
	svg: SVGSVGElement,
	datum: { x?: number; y?: number },
) => {
	const transform = d3.zoomTransform(svg);
	return {
		k: transform.k,
		x: (datum.x ?? 0) * transform.k + transform.x,
		y: (datum.y ?? 0) * transform.k + transform.y,
	};
};

type SimulatedNode = Datum & SimulationNodeDatum;

/** The simulation the most recently mounted renderer created. */
const latestSimulation = () =>
	vi.mocked(d3.forceSimulation).mock.results.at(-1)
		?.value as Simulation<SimulatedNode>;

/** A simulation's tick listener, to run ticks without the d3 timer. */
const tickListenerOf = (simulation: Simulation<SimulatedNode>) =>
	(simulation as unknown as { on(typenames: string): () => void }).on("tick");

/**
 * A point and radius in an element's own coordinates, in the SVG's screen
 * space: applies the translate and scale transforms of the element and its
 * ancestors.
 */
const toScreen = (element: Element, x: number, y: number, r: number) => {
	let point = { r, x, y };
	for (
		let node: Element | null = element;
		node && node.tagName.toLowerCase() !== "svg";
		node = node.parentElement
	) {
		const transform = node.getAttribute("transform") ?? "";
		const translate = /translate\(([-\d.e]+),\s*([-\d.e]+)\)/.exec(transform);
		const scale = /scale\(([-\d.e]+)\)/.exec(transform);
		const k = scale ? Number(scale[1]) : 1;
		point = {
			r: point.r * k,
			x: (translate ? Number(translate[1]) : 0) + k * point.x,
			y: (translate ? Number(translate[2]) : 0) + k * point.y,
		};
	}
	return point;
};

/** Copies of the nodes with the first one a claim whose fact-check is in flight. */
const withProcessingClaim = (source: MapGraphNode[]): MapGraphNode[] =>
	source.map((node, index) =>
		index === 0
			? {
					...node,
					metadata: {
						...node.metadata,
						epistemicKind: "claim",
						factCheck: {
							startedAt: "2026-09-15T10:00:00.000Z",
							status: "processing",
						},
						kind: "claim",
					},
				}
			: node,
	);

const inMap = (ui: ReactNode, store: MapInteractionStore) => (
	<MantineProvider>
		<I18nProvider i18n={i18n}>
			<MapInteractionProvider store={store}>{ui}</MapInteractionProvider>
		</I18nProvider>
	</MantineProvider>
);

const renderInMap = (ui: ReactNode, store: MapInteractionStore) =>
	render(inMap(ui, store));

/** Copies of the nodes with one late vector component changed on the first node. */
const withChangedVector = (source: MapGraphNode[]) =>
	source.map((node, index) =>
		index === 0
			? {
					...node,
					embedding: node.embedding.map((value, dim) =>
						dim === node.embedding.length - 1 ? value + 0.5 : value,
					),
				}
			: { ...node },
	);

describe("MstMap", () => {
	it("renders every node and tree edge and selects a starting node", () => {
		const store = createMapInteractionStore();
		const onActiveNodeChange = vi.fn();
		const { container } = renderInMap(
			<MstMap
				edgeLimit={EDGE_LIMIT}
				nodes={nodes}
				onActiveNodeChange={onActiveNodeChange}
			/>,
			store,
		);

		expect(container.querySelectorAll("circle.node")).toHaveLength(20);
		expect(container.querySelectorAll(".links-group line")).toHaveLength(19);

		const selected = store.getState().selectedNodeId;
		expect(nodes.some((node) => node.id === selected)).toBe(true);
		expect(onActiveNodeChange).toHaveBeenCalledWith(
			expect.objectContaining({ id: selected }),
			expect.any(Number),
			DEFAULT_WALK_INTERVAL_MS,
		);
	});

	it("casts one shadow for the node group, not one per circle", () => {
		const store = createMapInteractionStore();
		const { container, rerender } = renderInMap(
			<MstMap edgeLimit={EDGE_LIMIT} nodes={nodes} autoAdvance={false} />,
			store,
		);

		const group = container.querySelector("g.circle-nodes");
		expect(group?.getAttribute("filter")).toContain("drop-shadow");
		const circles = Array.from(container.querySelectorAll("circle.node"));
		expect(
			circles.filter((circle) => circle.hasAttribute("filter")),
		).toHaveLength(0);

		rerender(
			inMap(
				<MstMap
					edgeLimit={EDGE_LIMIT}
					nodes={nodes}
					autoAdvance={false}
					darkMode
				/>,
				store,
			),
		);
		expect(
			container.querySelector("g.circle-nodes")?.getAttribute("filter"),
		).toBe("none");
	});

	it("highlights the whole tree when the centre is hovered", () => {
		const store = createMapInteractionStore();
		const { container } = renderInMap(
			<MstMap edgeLimit={EDGE_LIMIT} nodes={nodes} autoAdvance={false} />,
			store,
		);

		const circles = Array.from(container.querySelectorAll("circle.node"));
		// Hover every node in turn; the largest downstream set is the full tree.
		let largest = 0;
		for (const circle of circles) {
			fireEvent.mouseEnter(circle);
			largest = Math.max(largest, store.getState().highlightedNodeIds.size);
			expect(store.getState().highlightSource).toBe("mst-hover");
			fireEvent.mouseLeave(circle);
		}
		expect(largest).toBe(20);
		expect(store.getState().highlightedNodeIds.size).toBe(0);
	});

	it("opens the force parameters panel", () => {
		renderInMap(
			<MstMap edgeLimit={EDGE_LIMIT} nodes={nodes} />,
			createMapInteractionStore(),
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Force Graph Settings" }),
		);

		expect(screen.getByText("Force Parameters")).toBeTruthy();
		expect(screen.getAllByRole("slider")).toHaveLength(5);
		expect(screen.getByRole("button", { name: "Reset" })).toBeTruthy();
	});

	it("keeps node elements, positions and the zoom group when the container resizes", () => {
		vi.mocked(mstLinkDistance).mockClear();
		const { container } = renderInMap(
			<MstMap edgeLimit={EDGE_LIMIT} nodes={nodes} autoAdvance={false} />,
			createMapInteractionStore(),
		);

		// Mount uses the scaled link distance at the mount size
		const mountK = fruchtermanReingoldK(800, 600, 20);
		expect(vi.mocked(mstLinkDistance).mock.calls.length).toBeGreaterThan(0);
		for (const call of vi.mocked(mstLinkDistance).mock.calls) {
			expect(call[1]).toEqual(MST_FORCE_DEFAULTS.link);
			expect(call[2]).toBe(mountK);
		}

		const zoomGroup = container.querySelector("svg > g");
		const circles = Array.from(container.querySelectorAll("circle.node"));
		const data = circles.map((circle) => datumOf(circle));
		// Move every node off the radial layout, as simulation ticks would
		for (const d of data) {
			d.x = (d.x ?? 0) + 37;
			d.y = (d.y ?? 0) - 11;
		}
		const positions = data.map((d) => [d.x, d.y]);

		vi.mocked(mstLinkDistance).mockClear();
		act(() => resizeContainers(1440, 900));

		expect(container.querySelector("svg")?.getAttribute("width")).toBe("1440");
		expect(container.querySelector("svg > g")).toBe(zoomGroup);
		const after = Array.from(container.querySelectorAll("circle.node"));
		expect(after).toHaveLength(20);
		after.forEach((circle, index) => {
			expect(circle).toBe(circles[index]);
			expect(datumOf(circle)).toBe(data[index]);
		});
		expect(
			after.map((circle) => [datumOf(circle).x, datumOf(circle).y]),
		).toEqual(positions);

		// Link lengths follow the new size with the same scaled formula
		const resizedK = fruchtermanReingoldK(1440, 900, 20);
		expect(vi.mocked(mstLinkDistance).mock.calls.length).toBeGreaterThan(0);
		for (const call of vi.mocked(mstLinkDistance).mock.calls) {
			expect(call[2]).toBe(resizedK);
		}
	});

	it("keeps the tree rendered and scaled when a force parameter changes or resets", () => {
		const { container } = renderInMap(
			<MstMap edgeLimit={EDGE_LIMIT} nodes={nodes} autoAdvance={false} />,
			createMapInteractionStore(),
		);
		const circles = Array.from(container.querySelectorAll("circle.node"));
		const lines = Array.from(container.querySelectorAll(".links-group line"));
		const k = fruchtermanReingoldK(800, 600, 20);

		const expectSameElements = () => {
			const nowCircles = Array.from(container.querySelectorAll("circle.node"));
			const nowLines = Array.from(
				container.querySelectorAll(".links-group line"),
			);
			expect(nowCircles).toHaveLength(20);
			expect(nowLines).toHaveLength(19);
			nowCircles.forEach((circle, index) => {
				expect(circle).toBe(circles[index]);
			});
			nowLines.forEach((line, index) => {
				expect(line).toBe(lines[index]);
			});
		};

		fireEvent.click(
			screen.getByRole("button", { name: "Force Graph Settings" }),
		);

		vi.mocked(mstLinkDistance).mockClear();
		const [minimumLinkLength] = screen.getAllByRole("slider");
		fireEvent.change(minimumLinkLength, { target: { value: "12" } });

		expectSameElements();
		expect(vi.mocked(mstLinkDistance).mock.calls).toHaveLength(19);
		for (const call of vi.mocked(mstLinkDistance).mock.calls) {
			expect(call[1]).toEqual({ ...MST_FORCE_DEFAULTS.link, constant: 12 });
			expect(call[2]).toBe(k);
		}

		vi.mocked(mstLinkDistance).mockClear();
		fireEvent.click(screen.getByRole("button", { name: "Reset" }));

		expectSameElements();
		expect(vi.mocked(mstLinkDistance).mock.calls).toHaveLength(19);
		for (const call of vi.mocked(mstLinkDistance).mock.calls) {
			expect(call[1]).toEqual(MST_FORCE_DEFAULTS.link);
			expect(call[2]).toBe(k);
		}
	});

	it("drops the downstream highlight when the hovered node leaves, the tree empties or the map unmounts", () => {
		const store = createMapInteractionStore();
		const view = renderInMap(
			<MstMap edgeLimit={EDGE_LIMIT} nodes={nodes} autoAdvance={false} />,
			store,
		);
		const highlighted = () => store.getState().highlightedNodeIds;

		const hovered = view.container.querySelectorAll("circle.node")[5];
		const hoveredId = datumOf(hovered).id;
		fireEvent.mouseEnter(hovered);
		expect(highlighted().has(hoveredId)).toBe(true);

		// The node goes without a mouseleave, and stays unhighlighted when it returns
		const without = nodes.filter((node) => node.id !== hoveredId);
		view.rerender(
			inMap(
				<MstMap edgeLimit={EDGE_LIMIT} nodes={without} autoAdvance={false} />,
				store,
			),
		);
		expect(highlighted().size).toBe(0);
		view.rerender(
			inMap(
				<MstMap edgeLimit={EDGE_LIMIT} nodes={nodes} autoAdvance={false} />,
				store,
			),
		);
		expect(highlighted().size).toBe(0);

		fireEvent.mouseEnter(view.container.querySelectorAll("circle.node")[0]);
		expect(highlighted().size).toBeGreaterThan(0);
		view.rerender(
			inMap(
				<MstMap edgeLimit={EDGE_LIMIT} nodes={[]} autoAdvance={false} />,
				store,
			),
		);
		expect(highlighted().size).toBe(0);

		view.rerender(
			inMap(
				<MstMap edgeLimit={EDGE_LIMIT} nodes={nodes} autoAdvance={false} />,
				store,
			),
		);
		fireEvent.mouseEnter(view.container.querySelectorAll("circle.node")[0]);
		expect(highlighted().size).toBeGreaterThan(0);
		view.unmount();
		expect(highlighted().size).toBe(0);
	});

	it("keeps pulsing in-flight fact-checks while the simulation is stopped", async () => {
		vi.mocked(d3.forceSimulation).mockClear();
		const { container } = renderInMap(
			<MstMap
				edgeLimit={EDGE_LIMIT}
				nodes={withProcessingClaim(nodes)}
				colorBy="factCheck"
				autoAdvance={false}
			/>,
			createMapInteractionStore(),
		);
		latestSimulation().stop();

		const circle = circleOf(container, nodes[0].id);
		const stoppedAt = circle.getAttribute("opacity");
		await waitFor(() => {
			expect(circle.getAttribute("opacity")).not.toBe(stoppedAt);
		});
	});

	it("cancels a running auto-fit when the node set changes and on unmount", () => {
		vi.mocked(d3.forceSimulation).mockClear();
		const store = createMapInteractionStore();
		const view = renderInMap(
			<MstMap edgeLimit={EDGE_LIMIT} nodes={nodes} autoAdvance={false} />,
			store,
		);
		const svg = view.container.querySelector(
			'svg[aria-label="Argument map"]',
		) as SVGSVGElement & { __transition?: unknown };
		const simulation = latestSimulation();
		const tick = tickListenerOf(simulation);

		// Spread the nodes far past the viewport and run ten ticks by hand:
		// auto-fit schedules a zoom-out transition on the SVG
		const outgrowViewport = () => {
			simulation.stop();
			for (const node of simulation.nodes()) {
				node.x = (node.x ?? 0) * 40;
				node.y = (node.y ?? 0) * 40;
			}
			for (let i = 0; i < 10; i++) tick();
		};

		outgrowViewport();
		expect(svg.__transition).toBeDefined();

		view.rerender(
			inMap(
				<MstMap
					edgeLimit={EDGE_LIMIT}
					nodes={nodes.slice(1)}
					autoAdvance={false}
				/>,
				store,
			),
		);
		expect(svg.__transition).toBeUndefined();

		// The fit deadline was reset with it, so the next check fits at once
		outgrowViewport();
		expect(svg.__transition).toBeDefined();

		view.unmount();
		expect(svg.__transition).toBeUndefined();
	});
});

describe("MstMap random walk", () => {
	beforeEach(() => {
		vi.useFakeTimers({
			toFake: [
				"setTimeout",
				"clearTimeout",
				"setInterval",
				"clearInterval",
				"Date",
			],
		});
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	it("restarts the 30 s interval when the LocalMap selects a node", () => {
		const store = createMapInteractionStore();
		const { container } = renderInMap(
			<div>
				<MstMap edgeLimit={EDGE_LIMIT} nodes={nodes} />
				<LocalMap edgeLimit={EDGE_LIMIT} nodes={nodes} />
			</div>,
			store,
		);
		const first = store.getState().selectedNodeId;
		expect(first).not.toBeNull();

		act(() => {
			vi.advanceTimersByTime(20_000);
		});
		expect(store.getState().selectedNodeId).toBe(first);

		// Click another node in the LocalMap, 20 s into the walk interval
		const localCircles = container.querySelectorAll(
			'svg[aria-label="Local argument map"] circle.node',
		);
		const other = Array.from(localCircles).find(
			(circle) => datumOf(circle).id !== first,
		) as Element;
		const otherId = datumOf(other).id;
		fireEvent.click(other);
		expect(store.getState().selectedNodeId).toBe(otherId);

		// The old schedule would have moved on 10 s after the click
		act(() => {
			vi.advanceTimersByTime(29_000);
		});
		expect(store.getState().selectedNodeId).toBe(otherId);

		act(() => {
			vi.advanceTimersByTime(1_500);
		});
		const next = store.getState().selectedNodeId as string;
		const neighbours = adjacencyOf(nodes, buildMST(nodes)).get(otherId);
		expect(neighbours?.has(next)).toBe(true);
	});

	it("restarts the interval when the page changes the selection", () => {
		const store = createMapInteractionStore();
		renderInMap(<MstMap edgeLimit={EDGE_LIMIT} nodes={nodes} />, store);
		const first = store.getState().selectedNodeId;

		act(() => {
			vi.advanceTimersByTime(25_000);
		});
		const other = nodes.find((node) => node.id !== first)?.id as string;
		act(() => {
			store.setSelectedNodeId(other);
		});

		act(() => {
			vi.advanceTimersByTime(29_000);
		});
		expect(store.getState().selectedNodeId).toBe(other);
		act(() => {
			vi.advanceTimersByTime(1_500);
		});
		expect(store.getState().selectedNodeId).not.toBe(other);
	});

	it("restarts the interval when the LocalMap selects the selected node again", () => {
		const store = createMapInteractionStore();
		const { container } = renderInMap(
			<div>
				<MstMap edgeLimit={EDGE_LIMIT} nodes={nodes} />
				<LocalMap edgeLimit={EDGE_LIMIT} nodes={nodes} />
			</div>,
			store,
		);
		const first = store.getState().selectedNodeId as string;

		act(() => {
			vi.advanceTimersByTime(20_000);
		});
		expect(store.getState().selectedNodeId).toBe(first);

		fireEvent.click(circleOf(localSvgOf(container), first));
		expect(store.getState().selectedNodeId).toBe(first);

		// The old schedule would have moved on 10 s after the click
		act(() => {
			vi.advanceTimersByTime(29_000);
		});
		expect(store.getState().selectedNodeId).toBe(first);

		act(() => {
			vi.advanceTimersByTime(1_500);
		});
		const next = store.getState().selectedNodeId as string;
		const neighbours = adjacencyOf(nodes, buildMST(nodes)).get(first);
		expect(neighbours?.has(next)).toBe(true);
	});

	it("keeps the initial selection with autoAdvance off", () => {
		const store = createMapInteractionStore();
		renderInMap(
			<MstMap edgeLimit={EDGE_LIMIT} nodes={nodes} autoAdvance={false} />,
			store,
		);
		const first = store.getState().selectedNodeId;
		expect(first).not.toBeNull();

		act(() => {
			vi.advanceTimersByTime(60_000);
		});
		expect(store.getState().selectedNodeId).toBe(first);
	});
});

describe("LocalMap", () => {
	it("renders every node and hides the nearest-neighbour links by default", () => {
		const { container } = renderInMap(
			<LocalMap edgeLimit={EDGE_LIMIT} nodes={nodes} />,
			createMapInteractionStore(),
		);

		expect(container.querySelectorAll("circle.node")).toHaveLength(20);
		expect(container.querySelectorAll(".nn-links-group line")).toHaveLength(0);
	});

	it("draws every nearest-neighbour pair once when asked to and the budget allows", () => {
		const { container } = renderInMap(
			<LocalMap edgeLimit={EDGE_LIMIT} nodes={nodes} showNeighbourLinks />,
			createMapInteractionStore(),
		);

		// Ten neighbours per node, a pair listed from both ends drawn once
		const { nnLinks } = buildLocalMapForces(
			nodes,
			0.2,
			2.0,
			seededRandom(LOCAL_MAP_SEED),
		);
		const pairs = orderNeighbourPairs(nnLinks, null).length;
		expect(pairs).toBeLessThan(20 * 10);
		expect(pairs).toBeLessThanOrEqual(EDGE_LIMIT);
		expect(container.querySelectorAll(".nn-links-group line")).toHaveLength(
			pairs,
		);
	});

	it("draws nearest-neighbour lines between their nodes as the simulation runs", async () => {
		const { container } = renderInMap(
			<LocalMap edgeLimit={EDGE_LIMIT} nodes={nodes} showNeighbourLinks />,
			createMapInteractionStore(),
		);
		const circleById = new Map(
			Array.from(container.querySelectorAll("circle.node")).map((circle) => [
				datumOf(circle).id,
				circle,
			]),
		);
		const lines = Array.from(
			container.querySelectorAll(".nn-links-group line"),
		);
		const firstCircle = circleById.get(nodes[0].id);
		const startCx = firstCircle?.getAttribute("cx");

		// Wait until the simulation has ticked and moved the nodes
		await waitFor(() => {
			expect(firstCircle?.getAttribute("cx")).not.toBe(startCx);
		});

		for (const line of lines) {
			const { source, target } = datumOf<{ source: string; target: string }>(
				line,
			);
			const x1 = line.getAttribute("x1");
			expect(Number.isFinite(Number(x1)) && x1 !== null).toBe(true);
			expect(x1).toBe(circleById.get(source)?.getAttribute("cx"));
			expect(line.getAttribute("y1")).toBe(
				circleById.get(source)?.getAttribute("cy"),
			);
			expect(line.getAttribute("x2")).toBe(
				circleById.get(target)?.getAttribute("cx"),
			);
			expect(line.getAttribute("y2")).toBe(
				circleById.get(target)?.getAttribute("cy"),
			);
			expect(line.getAttribute("stroke-width")).toBe("1");
		}
	});

	it("casts one shadow for the node group, not one per circle", () => {
		const store = createMapInteractionStore();
		const { container } = renderInMap(
			<LocalMap edgeLimit={EDGE_LIMIT} nodes={nodes} />,
			store,
		);

		expect(
			container.querySelector("g.circle-nodes")?.getAttribute("filter"),
		).toContain("drop-shadow");
		const circles = Array.from(container.querySelectorAll("circle.node"));
		expect(
			circles.filter((circle) => circle.hasAttribute("filter")),
		).toHaveLength(0);
	});

	it("selects a clicked node through the store and enlarges it", () => {
		const store = createMapInteractionStore();
		const { container } = renderInMap(
			<LocalMap edgeLimit={EDGE_LIMIT} nodes={nodes} />,
			store,
		);

		const circle = container.querySelectorAll("circle.node")[3];
		fireEvent.click(circle);

		expect(store.getState().selectedNodeId).toBe(nodes[3].id);
		expect(circle.getAttribute("r")).toBe("12");
	});

	it("toggles pause and opens the LocalMap forces panel", () => {
		renderInMap(
			<LocalMap edgeLimit={EDGE_LIMIT} nodes={nodes} />,
			createMapInteractionStore(),
		);

		fireEvent.click(screen.getByRole("button", { name: "Pause physics" }));
		expect(screen.getByRole("button", { name: "Resume physics" })).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "LocalMap Settings" }));
		expect(screen.getByText("LocalMap Forces")).toBeTruthy();
		expect(screen.getAllByRole("slider")).toHaveLength(7);
	});

	it("keeps node elements when a force slider changes or the container resizes", () => {
		const { container } = renderInMap(
			<LocalMap edgeLimit={EDGE_LIMIT} nodes={nodes} />,
			createMapInteractionStore(),
		);
		const circles = Array.from(container.querySelectorAll("circle.node"));

		fireEvent.click(screen.getByRole("button", { name: "LocalMap Settings" }));
		const [cMedSlider] = screen.getAllByRole("slider");
		fireEvent.change(cMedSlider, { target: { value: "20" } });
		act(() => resizeContainers(1440, 900));

		const after = Array.from(container.querySelectorAll("circle.node"));
		expect(after).toHaveLength(20);
		after.forEach((circle, index) => {
			expect(circle).toBe(circles[index]);
		});
	});

	it("sizes the settings panel to its map column and scrolls inside it", () => {
		renderInMap(
			<LocalMap edgeLimit={EDGE_LIMIT} nodes={nodes} />,
			createMapInteractionStore(),
		);
		fireEvent.click(screen.getByRole("button", { name: "LocalMap Settings" }));

		const panel = screen.getByTestId("map-settings-panel");
		expect(panel.className).toContain("max-w-[calc(100%-2rem)]");
		expect(panel.className).toContain("max-h-[calc(100%-5rem)]");
		expect(panel.className).toContain("overflow-y-auto");
	});

	it("drops a queued hover frame when the pointer leaves", () => {
		const frames = new Map<number, FrameRequestCallback>();
		let nextFrame = 1;
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			frames.set(nextFrame, callback);
			return nextFrame++;
		});
		vi.stubGlobal("cancelAnimationFrame", (id: number) => {
			frames.delete(id);
		});
		// A still clock keeps the second move inside the 50 ms throttle
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			const store = createMapInteractionStore();
			const { container } = renderInMap(
				<LocalMap edgeLimit={EDGE_LIMIT} nodes={nodes} />,
				store,
			);
			const svg = localSvgOf(container);
			const { x = 0, y = 0 } = datumOf(
				container.querySelectorAll("circle.node")[0],
			);

			fireEvent.mouseMove(svg, { clientX: x, clientY: y });
			expect(store.getState().highlightSource).toBe("local-hover");
			fireEvent.mouseMove(svg, { clientX: x + 1, clientY: y });
			expect(frames.size).toBe(1);

			fireEvent.mouseLeave(svg);
			act(() => {
				for (const callback of [...frames.values()]) callback(0);
			});

			expect(store.getState().highlightedNodeIds.size).toBe(0);
			expect(container.querySelector(".cursor-overlay")).toBeNull();
		} finally {
			vi.useRealTimers();
			vi.unstubAllGlobals();
		}
	});

	it("keeps the cursor ring and timer arc on the cursor at screen size while the map zooms", () => {
		const { container } = renderInMap(
			<LocalMap
				edgeLimit={EDGE_LIMIT}
				nodes={nodes}
				timerActive
				timerProgress={0.25}
			/>,
			createMapInteractionStore(),
		);
		const svg = localSvgOf(container);
		// d3-zoom reads the SVG's size for a gesture; jsdom has no SVG lengths
		Object.defineProperty(svg, "width", { value: { baseVal: { value: 800 } } });
		Object.defineProperty(svg, "height", {
			value: { baseVal: { value: 600 } },
		});

		const expectOnCursor = (
			point: { x: number; y: number; r: number },
			r: number,
		) => {
			expect(point.x).toBeCloseTo(120);
			expect(point.y).toBeCloseTo(90);
			expect(point.r).toBeCloseTo(r);
		};
		const ringOnScreen = () => {
			const ring = container.querySelector(".cursor-overlay") as Element;
			return toScreen(
				ring,
				Number(ring.getAttribute("cx")),
				Number(ring.getAttribute("cy")),
				Number(ring.getAttribute("r")),
			);
		};
		const arcOnScreen = () => {
			const arc = container.querySelector(".timer-arc") as Element;
			const outer = /A([-\d.e]+),/.exec(arc.getAttribute("d") ?? "");
			return toScreen(arc, 0, 0, Number(outer?.[1]));
		};

		fireEvent.mouseMove(svg, { clientX: 120, clientY: 90 });
		expectOnCursor(ringOnScreen(), 50);
		expectOnCursor(arcOnScreen(), 52);

		// Wheel-zoom around another point while the pointer stays put
		fireEvent.wheel(svg, { clientX: 400, clientY: 300, deltaY: -300 });
		expect(
			container.querySelector("svg > g")?.getAttribute("transform"),
		).toMatch(/scale\((?!1\))/);

		expectOnCursor(ringOnScreen(), 50);
		expectOnCursor(arcOnScreen(), 52);
	});

	it("clears its hover highlight when the hovered node leaves the map", () => {
		const store = createMapInteractionStore();
		const { container, rerender } = renderInMap(
			<LocalMap edgeLimit={EDGE_LIMIT} nodes={nodes} />,
			store,
		);
		const hovered = datumOf(container.querySelectorAll("circle.node")[0]);
		const point = screenPointOf(localSvgOf(container), hovered);
		fireEvent.mouseMove(localSvgOf(container), {
			clientX: point.x,
			clientY: point.y,
		});
		expect(store.getState().highlightedNodeIds.has(hovered.id)).toBe(true);

		const without = nodes.filter((node) => node.id !== hovered.id);
		rerender(inMap(<LocalMap edgeLimit={EDGE_LIMIT} nodes={without} />, store));
		expect(store.getState().highlightedNodeIds.has(hovered.id)).toBe(false);
	});

	it("clears its hover highlight on unmount", () => {
		const store = createMapInteractionStore();
		const { container, unmount } = renderInMap(
			<LocalMap edgeLimit={EDGE_LIMIT} nodes={nodes} />,
			store,
		);
		const hovered = datumOf(container.querySelectorAll("circle.node")[0]);
		const point = screenPointOf(localSvgOf(container), hovered);
		fireEvent.mouseMove(localSvgOf(container), {
			clientX: point.x,
			clientY: point.y,
		});
		expect(store.getState().highlightSource).toBe("local-hover");
		expect(store.getState().highlightedNodeIds.size).toBeGreaterThan(0);

		unmount();
		expect(store.getState().highlightedNodeIds.size).toBe(0);
	});

	it("lets go of its simulation when the nodes run out", () => {
		vi.mocked(d3.forceSimulation).mockClear();
		const store = createMapInteractionStore();
		const { container, rerender } = renderInMap(
			<LocalMap edgeLimit={EDGE_LIMIT} nodes={nodes} />,
			store,
		);
		const restart = vi.spyOn(latestSimulation(), "restart");

		rerender(inMap(<LocalMap edgeLimit={EDGE_LIMIT} nodes={[]} />, store));
		expect(container.querySelectorAll("circle.node")).toHaveLength(0);
		restart.mockClear();

		// A slider change and a resize must not wake the old simulation
		fireEvent.click(screen.getByRole("button", { name: "LocalMap Settings" }));
		const [cMedSlider] = screen.getAllByRole("slider");
		fireEvent.change(cMedSlider, { target: { value: "20" } });
		act(() => resizeContainers(1440, 900));
		expect(restart).not.toHaveBeenCalled();

		rerender(inMap(<LocalMap edgeLimit={EDGE_LIMIT} nodes={nodes} />, store));
		expect(vi.mocked(d3.forceSimulation)).toHaveBeenCalledTimes(2);
		expect(container.querySelectorAll("circle.node")).toHaveLength(20);
	});

	it("keeps pulsing in-flight fact-checks while physics is paused", async () => {
		const { container } = renderInMap(
			<LocalMap
				edgeLimit={EDGE_LIMIT}
				nodes={withProcessingClaim(nodes)}
				colorBy="factCheck"
			/>,
			createMapInteractionStore(),
		);
		fireEvent.click(screen.getByRole("button", { name: "Pause physics" }));

		const circle = circleOf(container, nodes[0].id);
		const pausedAt = circle.getAttribute("opacity");
		await waitFor(() => {
			expect(circle.getAttribute("opacity")).not.toBe(pausedAt);
		});
	});
});

describe("at release scale (200 nodes)", () => {
	const big = createSyntheticMap({ count: 200, dims: 64 });

	beforeEach(() => {
		vi.mocked(buildMST).mockClear();
	});

	it("renders both renderers without errors", () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const { container } = renderInMap(
			<div>
				<MstMap edgeLimit={EDGE_LIMIT} nodes={big} autoAdvance={false} />
				<LocalMap edgeLimit={EDGE_LIMIT} nodes={big} />
			</div>,
			createMapInteractionStore(),
		);

		expect(container.querySelectorAll("circle.node")).toHaveLength(400);
		expect(container.querySelectorAll(".links-group line")).toHaveLength(199);
		expect(container.querySelectorAll(".nn-links-group line")).toHaveLength(0);
		expect(errors).not.toHaveBeenCalled();
		errors.mockRestore();
	});

	it("builds the MstMap tree once per node set", () => {
		const store = createMapInteractionStore();
		const { rerender } = renderInMap(
			<MstMap edgeLimit={EDGE_LIMIT} nodes={big} autoAdvance={false} />,
			store,
		);
		expect(vi.mocked(buildMST)).toHaveBeenCalledTimes(1);

		// A refetch with equal ids and vectors reuses the tree
		rerender(
			inMap(
				<MstMap
					edgeLimit={EDGE_LIMIT}
					nodes={big.map((node) => ({ ...node }))}
					autoAdvance={false}
				/>,
				store,
			),
		);
		expect(vi.mocked(buildMST)).toHaveBeenCalledTimes(1);

		rerender(
			inMap(
				<MstMap
					edgeLimit={EDGE_LIMIT}
					nodes={withChangedVector(big)}
					autoAdvance={false}
				/>,
				store,
			),
		);
		expect(vi.mocked(buildMST)).toHaveBeenCalledTimes(2);
	});

	it("rebuilds the LocalMap geometry when any vector component changes", () => {
		const store = createMapInteractionStore();
		const { container, rerender } = renderInMap(
			<LocalMap edgeLimit={EDGE_LIMIT} nodes={big} />,
			store,
		);
		expect(vi.mocked(buildMST)).toHaveBeenCalledTimes(1);

		rerender(
			inMap(
				<LocalMap
					edgeLimit={EDGE_LIMIT}
					nodes={big.map((node) => ({ ...node }))}
				/>,
				store,
			),
		);
		expect(vi.mocked(buildMST)).toHaveBeenCalledTimes(1);

		rerender(
			inMap(
				<LocalMap edgeLimit={EDGE_LIMIT} nodes={withChangedVector(big)} />,
				store,
			),
		);
		expect(vi.mocked(buildMST)).toHaveBeenCalledTimes(2);
		expect(container.querySelectorAll("circle.node")).toHaveLength(200);
	});
});

// ---------------------------------------------------------------------------
// Mixed types: size, geometry stability, layout results, relationships
// ---------------------------------------------------------------------------

/** Copies of the nodes with the given indexes as tensions. */
const withTensions = (
	source: MapGraphNode[],
	indexes: number[],
): MapGraphNode[] =>
	source.map((node, index) =>
		indexes.includes(index)
			? {
					...node,
					metadata: { ...node.metadata, objectType: "tension", sizeScale: 1.5 },
				}
			: node,
	);

type CollideForce = { radius: () => (node: { id: string }) => number };

/** The collision radius a simulation gives one node. */
const collisionRadiusOf = (simulation: Simulation<SimulatedNode>, id: string) =>
	(simulation.force("collision") as unknown as CollideForce).radius()({ id });

const mapSvgs = (container: Element) =>
	Array.from(
		container.querySelectorAll(
			'svg[aria-label="Argument map"], svg[aria-label="Local argument map"]',
		),
	);

const mstSvgOf = (container: Element) =>
	container.querySelector('svg[aria-label="Argument map"]') as SVGSVGElement;

const positionsById = (svg: Element) =>
	new Map(
		Array.from(svg.querySelectorAll("circle.node")).map((circle) => {
			const { id, x, y } = datumOf(circle);
			return [id, [x, y]] as const;
		}),
	);

const relation = (
	source: string,
	target: string,
	index: number,
): MapRelation => ({
	basis: "extracted",
	id: `relation-${index}`,
	source,
	target,
	type: "holds_position",
});

describe("per-node size", () => {
	it("draws a tension at 1.5 times the radius, with the selected and recent scales on top", () => {
		// Nodes 10 to 19 are the ten newest; node 3 is selected
		const sized = withTensions(nodes, [2, 3, 15]);
		const store = createMapInteractionStore({ selectedNodeId: nodes[3].id });
		const { container } = renderInMap(
			<div>
				<MstMap edgeLimit={EDGE_LIMIT} nodes={sized} autoAdvance={false} />
				<LocalMap edgeLimit={EDGE_LIMIT} nodes={sized} />
			</div>,
			store,
		);

		const svgs = mapSvgs(container);
		expect(svgs).toHaveLength(2);
		for (const svg of svgs) {
			expect(circleOf(svg, nodes[0].id).getAttribute("r")).toBe("6");
			expect(circleOf(svg, nodes[2].id).getAttribute("r")).toBe("9");
			expect(circleOf(svg, nodes[15].id).getAttribute("r")).toBe("11.25");
			expect(circleOf(svg, nodes[3].id).getAttribute("r")).toBe("18");
		}
	});

	it("gives each node a collision radius from its own size in both renderers", () => {
		const sized = withTensions(nodes, [4]);
		renderInMap(
			<MstMap edgeLimit={EDGE_LIMIT} nodes={sized} autoAdvance={false} />,
			createMapInteractionStore(),
		);
		const mst = latestSimulation();
		expect(collisionRadiusOf(mst, nodes[4].id)).toBe(9 * 1.25);
		expect(collisionRadiusOf(mst, nodes[0].id)).toBe(6 * 1.25);

		renderInMap(
			<LocalMap edgeLimit={EDGE_LIMIT} nodes={sized} />,
			createMapInteractionStore(),
		);
		const local = latestSimulation();
		expect(collisionRadiusOf(local, nodes[4].id)).toBe(9 * 2);
		expect(collisionRadiusOf(local, nodes[0].id)).toBe(6 * 2);
	});

	it("updates radius and collision in place when a size changes, without rebuilding or restarting", () => {
		for (const renderer of ["mst", "local"] as const) {
			vi.mocked(d3.forceSimulation).mockClear();
			vi.mocked(buildMST).mockClear();
			const store = createMapInteractionStore({ selectedNodeId: nodes[0].id });
			const ui = (current: MapGraphNode[]) =>
				renderer === "mst" ? (
					<MstMap edgeLimit={EDGE_LIMIT} nodes={current} autoAdvance={false} />
				) : (
					<LocalMap edgeLimit={EDGE_LIMIT} nodes={current} />
				);
			const view = renderInMap(ui(nodes), store);
			const simulation = latestSimulation();
			const restart = vi.spyOn(simulation, "restart");
			const circles = Array.from(
				view.container.querySelectorAll("circle.node"),
			);

			view.rerender(inMap(ui(withTensions(nodes, [6])), store));

			expect(vi.mocked(d3.forceSimulation)).toHaveBeenCalledTimes(1);
			expect(vi.mocked(buildMST)).toHaveBeenCalledTimes(1);
			expect(restart).not.toHaveBeenCalled();
			const after = Array.from(view.container.querySelectorAll("circle.node"));
			after.forEach((circle, index) => {
				expect(circle).toBe(circles[index]);
			});
			expect(circleOf(view.container, nodes[6].id).getAttribute("r")).toBe("9");
			expect(collisionRadiusOf(simulation, nodes[6].id)).toBe(
				renderer === "mst" ? 9 * 1.25 : 9 * 2,
			);
			expect(store.getState().selectedNodeId).toBe(nodes[0].id);
			view.unmount();
		}
	});

	it("lets a larger node reach the cursor sooner by its extra radius", () => {
		const reaches = (source: MapGraphNode[]) => {
			const store = createMapInteractionStore();
			const view = renderInMap(
				<LocalMap edgeLimit={EDGE_LIMIT} nodes={source} />,
				store,
			);
			const svg = localSvgOf(view.container);
			const { x, y, k } = screenPointOf(
				svg,
				datumOf(circleOf(view.container, nodes[0].id)),
			);
			// Half the tension's extra radius (3 graph units, times the zoom) past
			// the 50 px ring: outside it for a base node, inside it for a tension
			fireEvent.mouseMove(svg, { clientX: x + 50 + 1.5 * k, clientY: y });
			const reached = store.getState().highlightedNodeIds.has(nodes[0].id);
			view.unmount();
			return reached;
		};
		expect(reaches(nodes)).toBe(false);
		expect(reaches(withTensions(nodes, [0]))).toBe(true);
	});
});

describe("geometry stability", () => {
	it("keeps geometry, elements, positions and selection through colour, verdict, label and size updates", () => {
		vi.mocked(d3.forceSimulation).mockClear();
		vi.mocked(buildMST).mockClear();
		const store = createMapInteractionStore();
		const ui = (current: MapGraphNode[], colorBy: ColorBy = "none") => (
			<div>
				<MstMap
					edgeLimit={EDGE_LIMIT}
					nodes={current}
					colorBy={colorBy}
					autoAdvance={false}
				/>
				<LocalMap edgeLimit={EDGE_LIMIT} nodes={current} colorBy={colorBy} />
			</div>
		);
		const view = renderInMap(ui(nodes), store);
		const selected = store.getState().selectedNodeId;
		const circles = Array.from(view.container.querySelectorAll("circle.node"));
		const positions = circles.map((circle) => [
			datumOf(circle).x,
			datumOf(circle).y,
		]);
		const builds = vi.mocked(buildMST).mock.calls.length;

		// Colour mode, then a verdict, then labels and sizes
		view.rerender(inMap(ui(nodes, "valence"), store));
		view.rerender(inMap(ui(withProcessingClaim(nodes), "factCheck"), store));
		const relabelled = withTensions(
			nodes.map((node) => ({ ...node, label: `${node.label} (edited)` })),
			[1, 8],
		);
		view.rerender(inMap(ui(relabelled, "type"), store));

		expect(vi.mocked(d3.forceSimulation)).toHaveBeenCalledTimes(2);
		expect(vi.mocked(buildMST).mock.calls.length).toBe(builds);
		const after = Array.from(view.container.querySelectorAll("circle.node"));
		expect(after).toHaveLength(circles.length);
		after.forEach((circle, index) => {
			expect(circle).toBe(circles[index]);
		});
		expect(
			after.map((circle) => [datumOf(circle).x, datumOf(circle).y]),
		).toEqual(positions);
		expect(store.getState().selectedNodeId).toBe(selected);

		// The updates themselves did land
		const local = localSvgOf(view.container);
		expect(circleOf(local, nodes[1].id).getAttribute("r")).toBe(
			nodes[1].id === selected ? "18" : "9",
		);
		expect(
			circleOf(local, nodes[5].id).querySelector("title")?.textContent,
		).toBe(`${nodes[5].label} (edited)`);
	});

	it("recomputes the tree once when the node set is filtered and keeps surviving positions", () => {
		vi.mocked(buildMST).mockClear();
		const store = createMapInteractionStore();
		const view = renderInMap(
			<MstMap edgeLimit={EDGE_LIMIT} nodes={nodes} autoAdvance={false} />,
			store,
		);
		for (const circle of view.container.querySelectorAll("circle.node")) {
			const d = datumOf(circle);
			d.x = (d.x ?? 0) + 13;
			d.y = (d.y ?? 0) - 7;
		}
		const before = positionsById(view.container);

		const filtered = nodes.filter((_, index) => index % 4 !== 1);
		view.rerender(
			inMap(
				<MstMap edgeLimit={EDGE_LIMIT} nodes={filtered} autoAdvance={false} />,
				store,
			),
		);
		// A refetch of the filtered set rebuilds nothing
		view.rerender(
			inMap(
				<MstMap
					edgeLimit={EDGE_LIMIT}
					nodes={filtered.map((node) => ({ ...node }))}
					autoAdvance={false}
				/>,
				store,
			),
		);

		expect(vi.mocked(buildMST)).toHaveBeenCalledTimes(2);
		expect(view.container.querySelectorAll(".links-group line")).toHaveLength(
			filtered.length - 1,
		);
		const after = positionsById(view.container);
		expect(after.size).toBe(filtered.length);
		for (const [id, position] of after) {
			expect(position).toEqual(before.get(id));
		}
	});
});

/** Both renderers on useMapGeometry, as the Map page wires them. */
function GeometryHarness({
	nodes: current,
	client,
	showNeighbourLinks = false,
	relations,
	showRelationships = false,
}: {
	nodes: MapGraphNode[];
	client?: LayoutClient;
	showNeighbourLinks?: boolean;
	relations?: MapRelation[];
	showRelationships?: boolean;
}) {
	const geometry = useMapGeometry(current, {
		client,
		nodeLimit: LEGACY_BUDGET_BOUNDS.defaults.nodeLimit,
	});
	return (
		<div>
			<MstMap
				edgeLimit={EDGE_LIMIT}
				nodes={current}
				mstEdges={geometry.mstEdges}
				relations={relations}
				showRelationships={showRelationships}
				autoAdvance={false}
			/>
			<LocalMap
				edgeLimit={EDGE_LIMIT}
				nodes={current}
				mstEdges={geometry.mstEdges}
				neighbours={geometry.neighbours}
				relations={relations}
				showRelationships={showRelationships}
				showNeighbourLinks={showNeighbourLinks}
			/>
		</div>
	);
}

describe("layout results from useMapGeometry", () => {
	it("draws the shared result and builds no tree or neighbours of its own", () => {
		vi.mocked(buildMST).mockClear();
		const { container } = renderInMap(
			<GeometryHarness nodes={nodes} showNeighbourLinks />,
			createMapInteractionStore(),
		);
		expect(vi.mocked(buildMST)).not.toHaveBeenCalled();
		expect(
			mstSvgOf(container).querySelectorAll(".links-group line"),
		).toHaveLength(19);
		const layout = runLayoutSync({ ...packVectors(nodes), nodeLimit: 20 });
		expect(
			localSvgOf(container).querySelectorAll(".nn-links-group line"),
		).toHaveLength(orderNeighbourPairs(layout.neighbours.nnLinks, null).length);
	});

	it("keeps drawing the last layout while a filtered node set computes, then applies it with surviving positions", () => {
		const worker = new FakeLayoutWorker();
		const client = new LayoutClient(fakeWorkerFactory(worker));
		const store = createMapInteractionStore();
		const view = renderInMap(
			<GeometryHarness client={client} nodes={nodes} />,
			store,
		);
		expect(
			mstSvgOf(view.container).querySelectorAll("circle.node"),
		).toHaveLength(0);

		act(() => worker.answer(worker.computes()[0]));
		expect(
			mstSvgOf(view.container).querySelectorAll("circle.node"),
		).toHaveLength(20);
		const before = positionsById(mstSvgOf(view.container));

		const filtered = nodes.slice(0, 12);
		view.rerender(
			inMap(<GeometryHarness client={client} nodes={filtered} />, store),
		);
		// Computing: still the last accepted geometry in both renderers
		expect(
			mstSvgOf(view.container).querySelectorAll("circle.node"),
		).toHaveLength(20);
		expect(
			mstSvgOf(view.container).querySelectorAll(".links-group line"),
		).toHaveLength(19);
		expect(
			localSvgOf(view.container).querySelectorAll("circle.node"),
		).toHaveLength(20);

		act(() => worker.answer(worker.computes()[1]));
		expect(
			mstSvgOf(view.container).querySelectorAll("circle.node"),
		).toHaveLength(12);
		expect(
			mstSvgOf(view.container).querySelectorAll(".links-group line"),
		).toHaveLength(11);
		expect(
			localSvgOf(view.container).querySelectorAll("circle.node"),
		).toHaveLength(12);
		for (const [id, position] of positionsById(mstSvgOf(view.container))) {
			expect(position).toEqual(before.get(id));
		}
	});

	it("never draws a result over a node set it was not computed for", () => {
		const resultFor = (source: MapGraphNode[]) => {
			const layout = runLayoutSync({
				...packVectors(source),
				nodeLimit: source.length,
			});
			return registerGeometryResult({
				centerId: layout.centerId,
				key: nodeGeometryKey(source),
				mstEdges: layout.mstEdges,
				neighbours: layout.neighbours,
			});
		};
		const first = resultFor(nodes);
		const filtered = nodes.slice(5);
		const store = createMapInteractionStore();
		const ui = (current: MapGraphNode[], edges = first.mstEdges) => (
			<MstMap
				edgeLimit={EDGE_LIMIT}
				nodes={current}
				mstEdges={edges}
				autoAdvance={false}
			/>
		);
		const view = renderInMap(ui(nodes), store);
		const ids = () =>
			Array.from(view.container.querySelectorAll("circle.node")).map(
				(circle) => datumOf(circle).id,
			);
		expect(ids()).toHaveLength(20);

		view.rerender(inMap(ui(filtered), store));
		expect(ids()).toHaveLength(20);

		view.rerender(inMap(ui(filtered, resultFor(filtered).mstEdges), store));
		expect(ids()).toEqual(filtered.map((node) => node.id));
	});
});

describe("relationship overlays", () => {
	const ids = nodes.map((node) => node.id);
	const denseRelations = createRelationFixture(ids, 8);
	/** Six lines more than the tree needs. */
	const tightEdgeLimit = minEdgeLimit(nodes.length) + 6;

	it("keeps every tree edge and draws relationships only in the budget the tree leaves", () => {
		const onEdgeCounts = vi.fn();
		const { container } = renderInMap(
			<MstMap
				edgeLimit={tightEdgeLimit}
				nodes={nodes}
				relations={denseRelations}
				showRelationships
				autoAdvance={false}
				onEdgeCounts={onEdgeCounts}
			/>,
			createMapInteractionStore(),
		);
		expect(container.querySelectorAll(".links-group line")).toHaveLength(19);
		expect(container.querySelectorAll("line.relation")).toHaveLength(6);
		const counts = onEdgeCounts.mock.calls.at(-1)?.[0];
		expect(counts).toMatchObject({
			drawn: tightEdgeLimit,
			neighbours: 0,
			relations: 6,
			tree: 19,
		});
		// The omitted lines are disclosed
		expect(counts.available).toBe(
			19 + relationLines(denseRelations, new Set(ids), null).length,
		);
	});

	it("draws the selected node's relationships without the toggle, dashed and apart from the tree", () => {
		const store = createMapInteractionStore({ selectedNodeId: nodes[0].id });
		const { container } = renderInMap(
			<MstMap
				edgeLimit={EDGE_LIMIT}
				nodes={nodes}
				relations={denseRelations}
				autoAdvance={false}
			/>,
			store,
		);
		const lines = Array.from(container.querySelectorAll("line.relation"));
		const incident = relationLines(
			denseRelations,
			new Set(ids),
			nodes[0].id,
		).filter((line) => line.incident);
		expect(incident.length).toBeGreaterThan(0);
		expect(lines).toHaveLength(incident.length);
		for (const line of lines) {
			const { source, target } = datumOf<{ source: string; target: string }>(
				line,
			);
			expect([source, target]).toContain(nodes[0].id);
			expect(line.getAttribute("stroke-dasharray")).toBe("6,4");
			expect(line.closest(".links-group")).toBeNull();
		}

		act(() => store.setSelectedNodeId(nodes[1].id));
		for (const line of container.querySelectorAll("line.relation")) {
			const { source, target } = datumOf<{ source: string; target: string }>(
				line,
			);
			expect([source, target]).toContain(nodes[1].id);
		}
	});

	it("keeps relationships out of the tree's link force", () => {
		renderInMap(
			<MstMap
				edgeLimit={EDGE_LIMIT}
				nodes={nodes}
				relations={denseRelations}
				showRelationships
				autoAdvance={false}
			/>,
			createMapInteractionStore(),
		);
		const linkForce = latestSimulation().force("link") as unknown as {
			links: () => unknown[];
		};
		expect(linkForce.links()).toHaveLength(19);
	});

	it("draws neighbour links within the shared budget, one line per pair, without touching the neighbour forces", () => {
		vi.mocked(createNearestNeighbourForce).mockClear();
		const onEdgeCounts = vi.fn();
		const store = createMapInteractionStore();
		const ui = (edgeLimit: number) => (
			<LocalMap
				edgeLimit={edgeLimit}
				nodes={nodes}
				showNeighbourLinks
				onEdgeCounts={onEdgeCounts}
			/>
		);
		const view = renderInMap(ui(tightEdgeLimit), store);
		const lines = () => view.container.querySelectorAll(".nn-links-group line");
		expect(lines()).toHaveLength(tightEdgeLimit);

		const forcePairs = vi.mocked(createNearestNeighbourForce).mock
			.calls[0][0] as LocalMapLink[];
		expect(forcePairs).toHaveLength(20 * 10);
		const pairs = orderNeighbourPairs(forcePairs, null).length;
		expect(onEdgeCounts.mock.calls.at(-1)?.[0]).toMatchObject({
			available: pairs,
			drawn: tightEdgeLimit,
			neighbours: tightEdgeLimit,
		});

		view.rerender(inMap(ui(EDGE_LIMIT), store));
		expect(lines()).toHaveLength(pairs);
		expect(vi.mocked(createNearestNeighbourForce)).toHaveBeenCalledTimes(1);
		expect(onEdgeCounts.mock.calls.at(-1)?.[0]).toMatchObject({
			available: pairs,
			drawn: pairs,
		});
	});

	it("gives relationships the LocalMap budget before neighbour links", () => {
		const { container } = renderInMap(
			<LocalMap
				edgeLimit={tightEdgeLimit}
				nodes={nodes}
				relations={denseRelations}
				showRelationships
				showNeighbourLinks
			/>,
			createMapInteractionStore(),
		);
		expect(container.querySelectorAll("line.relation")).toHaveLength(
			tightEdgeLimit,
		);
		expect(container.querySelectorAll(".nn-links-group line")).toHaveLength(0);
	});
});

describe("the walk with relationships", () => {
	beforeEach(() => {
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout", "Date"],
		});
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	it("steps along tree edges only, never along a relationship", () => {
		const neighbours = adjacencyOf(nodes, buildMST(nodes));
		// Every node related to every other: any step off the tree would show
		const everywhere = nodes.flatMap((node, index) =>
			nodes
				.slice(index + 1)
				.map((other, offset) =>
					relation(node.id, other.id, index * nodes.length + offset),
				),
		);
		const store = createMapInteractionStore({ selectedNodeId: nodes[0].id });
		renderInMap(
			<MstMap
				edgeLimit={EDGE_LIMIT}
				nodes={nodes}
				relations={everywhere}
				showRelationships
			/>,
			store,
		);
		for (let step = 0; step < 6; step++) {
			const from = store.getState().selectedNodeId as string;
			act(() => {
				vi.advanceTimersByTime(DEFAULT_WALK_INTERVAL_MS + 10);
			});
			const to = store.getState().selectedNodeId as string;
			expect(neighbours.get(from)?.has(to)).toBe(true);
		}
	});
});

describe("fitting the panel", () => {
	type PanelSize = { width: number; height: number };
	const TREE_PANEL: PanelSize = { height: 559, width: 393 };
	const LOCAL_PANEL: PanelSize = { height: 559, width: 309 };

	/** Gives the map containers a size: measured at creation, reported on change. */
	const stubPanelSize = (initial: PanelSize) => {
		const size = { ...initial };
		const spy = vi
			.spyOn(HTMLElement.prototype, "getBoundingClientRect")
			.mockImplementation(
				() =>
					({
						bottom: size.height,
						height: size.height,
						left: 0,
						right: size.width,
						toJSON: () => ({}),
						top: 0,
						width: size.width,
						x: 0,
						y: 0,
					}) as DOMRect,
			);
		const resize = (next: PanelSize) => {
			size.width = next.width;
			size.height = next.height;
			act(() => resizeContainers(next.width, next.height));
		};
		return { resize, restore: () => spy.mockRestore() };
	};

	/** The simulation moving one map's circles. */
	const simulationOf = (svg: Element) => {
		const datum = datumOf<SimulatedNode>(
			svg.querySelector("circle.node") as Element,
		);
		return vi
			.mocked(d3.forceSimulation)
			.mock.results.map((result) => result.value as Simulation<SimulatedNode>)
			.find((simulation) =>
				simulation.nodes().includes(datum),
			) as Simulation<SimulatedNode>;
	};

	/** Ticks by hand: the forces, then the renderer's listener (drawing and fitting). */
	const step = (simulation: Simulation<SimulatedNode>, ticks: number) => {
		const listener = tickListenerOf(simulation);
		for (let i = 0; i < ticks; i++) {
			(simulation as unknown as { tick: () => void }).tick();
			listener();
		}
	};

	/** Every circle and relationship line is on screen, and the map is not shrunk to a dot. */
	const expectFitsPanel = (
		svg: SVGSVGElement,
		panel: PanelSize,
		minFill: number,
	) => {
		const transform = d3.zoomTransform(svg);
		const xs: number[] = [];
		const ys: number[] = [];
		for (const circle of svg.querySelectorAll("circle.node")) {
			const point = screenPointOf(svg, datumOf(circle));
			xs.push(point.x);
			ys.push(point.y);
		}
		for (const line of svg.querySelectorAll("line.relation")) {
			for (const [xName, yName] of [
				["x1", "y1"],
				["x2", "y2"],
			] as const) {
				xs.push(Number(line.getAttribute(xName)) * transform.k + transform.x);
				ys.push(Number(line.getAttribute(yName)) * transform.k + transform.y);
			}
		}
		const minX = Math.min(...xs);
		const maxX = Math.max(...xs);
		const minY = Math.min(...ys);
		const maxY = Math.max(...ys);
		expect(minX).toBeGreaterThanOrEqual(0);
		expect(maxX).toBeLessThanOrEqual(panel.width);
		expect(minY).toBeGreaterThanOrEqual(0);
		expect(maxY).toBeLessThanOrEqual(panel.height);
		expect(
			Math.max((maxX - minX) / panel.width, (maxY - minY) / panel.height),
		).toBeGreaterThan(minFill);
	};

	/**
	 * Steps the layout and waits in real time (fit transitions run on timers)
	 * until the check passes. Not waitFor: it re-runs its callback on every DOM
	 * mutation, and stepping mutates the DOM, so it would never yield.
	 */
	const settleUntil = async (
		advance: () => void,
		check: () => void,
		timeoutMs = 8000,
	) => {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			advance();
			try {
				check();
				return;
			} catch (error) {
				if (Date.now() > deadline) throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};

	const lateLayout = (ui: (client: LayoutClient) => ReactNode) => {
		const worker = new FakeLayoutWorker();
		const client = new LayoutClient(fakeWorkerFactory(worker));
		const view = renderInMap(ui(client), createMapInteractionStore());
		const arrive = () => act(() => worker.answer(worker.computes()[0]));
		return { arrive, view };
	};

	it("fits both maps as soon as a late layout arrives, before any tick", () => {
		const panel = stubPanelSize(TREE_PANEL);
		try {
			const { view, arrive } = lateLayout((client) => (
				<GeometryHarness client={client} nodes={nodes} />
			));
			panel.resize(TREE_PANEL);
			arrive();

			expectFitsPanel(mstSvgOf(view.container), TREE_PANEL, 0.3);
			expectFitsPanel(localSvgOf(view.container), TREE_PANEL, 0.3);
		} finally {
			panel.restore();
		}
	});

	it("zooms the tree back in when a panel that was briefly narrow grows", async () => {
		const narrow = { height: 378, width: 60 };
		const panel = stubPanelSize(narrow);
		try {
			const { view, arrive } = lateLayout((client) => (
				<GeometryHarness client={client} nodes={nodes} />
			));
			panel.resize(narrow);
			arrive();
			const svg = mstSvgOf(view.container);
			const tree = simulationOf(svg);
			tree.stop();
			simulationOf(localSvgOf(view.container)).stop();
			step(tree, 40);
			const narrowScale = d3.zoomTransform(svg).k;

			panel.resize(TREE_PANEL);
			await settleUntil(
				() => step(tree, AUTO_FIT_EVERY_TICKS),
				() => expectFitsPanel(svg, TREE_PANEL, 0.4),
			);
			expect(d3.zoomTransform(svg).k).toBeGreaterThan(narrowScale * 2);
		} finally {
			panel.restore();
		}
	}, 20_000);

	it("keeps the local map and its relationship lines inside the panel once it settles", async () => {
		// The 50-argument fixture: at PR head most of its nodes settled outside
		// a 309 px panel, because the local map never fitted
		const fixtureNodes = buildMapGraph(
			fixtureMapData("50").response,
		).placedNodes;
		const panel = stubPanelSize(LOCAL_PANEL);
		try {
			const { view, arrive } = lateLayout((client) => (
				<GeometryHarness
					client={client}
					nodes={fixtureNodes}
					relations={createRelationFixture(
						fixtureNodes.map((node) => node.id),
						2,
					)}
					showRelationships
				/>
			));
			panel.resize(LOCAL_PANEL);
			arrive();
			const svg = localSvgOf(view.container);
			const local = simulationOf(svg);
			local.stop();
			simulationOf(mstSvgOf(view.container)).stop();
			step(local, 600);

			await settleUntil(
				() => step(local, AUTO_FIT_EVERY_TICKS),
				() => {
					expect(svg.querySelectorAll("line.relation").length).toBeGreaterThan(
						0,
					);
					expectFitsPanel(svg, LOCAL_PANEL, 0.3);
				},
			);
		} finally {
			panel.restore();
		}
	}, 20_000);
});
