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
import { createSyntheticMap } from "../fixtures/syntheticMap";
import {
	fruchtermanReingoldK,
	MST_FORCE_DEFAULTS,
	mstLinkDistance,
} from "../graph/forces";
import { adjacencyOf, buildMST } from "../graph/mst";
import {
	createMapInteractionStore,
	MapInteractionProvider,
	type MapInteractionStore,
} from "../state/interactionStore";
import type { MapGraphNode } from "../types";
import { LocalMap } from "./LocalMapGraph";
import { DEFAULT_WALK_INTERVAL_MS, MstMap } from "./MstGraph";

// Spies around the real implementations, to count MST builds and read the
// link distances the renderer asks for.
vi.mock("../graph/mst", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../graph/mst")>();
	return { ...actual, buildMST: vi.fn(actual.buildMST) };
});
vi.mock("../graph/forces", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../graph/forces")>();
	return { ...actual, mstLinkDistance: vi.fn(actual.mstLinkDistance) };
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
			<MstMap nodes={nodes} onActiveNodeChange={onActiveNodeChange} />,
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
			<MstMap nodes={nodes} autoAdvance={false} />,
			store,
		);

		const group = container.querySelector("g.circle-nodes");
		expect(group?.getAttribute("filter")).toContain("drop-shadow");
		const circles = Array.from(container.querySelectorAll("circle.node"));
		expect(
			circles.filter((circle) => circle.hasAttribute("filter")),
		).toHaveLength(0);

		rerender(
			inMap(<MstMap nodes={nodes} autoAdvance={false} darkMode />, store),
		);
		expect(
			container.querySelector("g.circle-nodes")?.getAttribute("filter"),
		).toBe("none");
	});

	it("highlights the whole tree when the centre is hovered", () => {
		const store = createMapInteractionStore();
		const { container } = renderInMap(
			<MstMap nodes={nodes} autoAdvance={false} />,
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
		renderInMap(<MstMap nodes={nodes} />, createMapInteractionStore());

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
			<MstMap nodes={nodes} autoAdvance={false} />,
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
			<MstMap nodes={nodes} autoAdvance={false} />,
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
				<MstMap nodes={nodes} />
				<LocalMap nodes={nodes} />
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
		renderInMap(<MstMap nodes={nodes} />, store);
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

	it("keeps the initial selection with autoAdvance off", () => {
		const store = createMapInteractionStore();
		renderInMap(<MstMap nodes={nodes} autoAdvance={false} />, store);
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
			<LocalMap nodes={nodes} />,
			createMapInteractionStore(),
		);

		expect(container.querySelectorAll("circle.node")).toHaveLength(20);
		expect(container.querySelectorAll(".nn-links-group line")).toHaveLength(0);
	});

	it("draws every nearest-neighbour link when asked to", () => {
		const { container } = renderInMap(
			<LocalMap nodes={nodes} showNeighbourLinks />,
			createMapInteractionStore(),
		);

		expect(container.querySelectorAll(".nn-links-group line")).toHaveLength(
			20 * 10,
		);
	});

	it("draws nearest-neighbour lines between their nodes as the simulation runs", async () => {
		const { container } = renderInMap(
			<LocalMap nodes={nodes} showNeighbourLinks />,
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
		const { container } = renderInMap(<LocalMap nodes={nodes} />, store);

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
		const { container } = renderInMap(<LocalMap nodes={nodes} />, store);

		const circle = container.querySelectorAll("circle.node")[3];
		fireEvent.click(circle);

		expect(store.getState().selectedNodeId).toBe(nodes[3].id);
		expect(circle.getAttribute("r")).toBe("12");
	});

	it("toggles pause and opens the LocalMap forces panel", () => {
		renderInMap(<LocalMap nodes={nodes} />, createMapInteractionStore());

		fireEvent.click(screen.getByRole("button", { name: "Pause physics" }));
		expect(screen.getByRole("button", { name: "Resume physics" })).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "LocalMap Settings" }));
		expect(screen.getByText("LocalMap Forces")).toBeTruthy();
		expect(screen.getAllByRole("slider")).toHaveLength(7);
	});

	it("keeps node elements when a force slider changes or the container resizes", () => {
		const { container } = renderInMap(
			<LocalMap nodes={nodes} />,
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
		renderInMap(<LocalMap nodes={nodes} />, createMapInteractionStore());
		fireEvent.click(screen.getByRole("button", { name: "LocalMap Settings" }));

		const panel = screen.getByTestId("map-settings-panel");
		expect(panel.className).toContain("max-w-[calc(100%-2rem)]");
		expect(panel.className).toContain("max-h-[calc(100%-5rem)]");
		expect(panel.className).toContain("overflow-y-auto");
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
				<MstMap nodes={big} autoAdvance={false} />
				<LocalMap nodes={big} />
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
			<MstMap nodes={big} autoAdvance={false} />,
			store,
		);
		expect(vi.mocked(buildMST)).toHaveBeenCalledTimes(1);

		// A refetch with equal ids and vectors reuses the tree
		rerender(
			inMap(
				<MstMap nodes={big.map((node) => ({ ...node }))} autoAdvance={false} />,
				store,
			),
		);
		expect(vi.mocked(buildMST)).toHaveBeenCalledTimes(1);

		rerender(
			inMap(
				<MstMap nodes={withChangedVector(big)} autoAdvance={false} />,
				store,
			),
		);
		expect(vi.mocked(buildMST)).toHaveBeenCalledTimes(2);
	});

	it("rebuilds the LocalMap geometry when any vector component changes", () => {
		const store = createMapInteractionStore();
		const { container, rerender } = renderInMap(
			<LocalMap nodes={big} />,
			store,
		);
		expect(vi.mocked(buildMST)).toHaveBeenCalledTimes(1);

		rerender(
			inMap(<LocalMap nodes={big.map((node) => ({ ...node }))} />, store),
		);
		expect(vi.mocked(buildMST)).toHaveBeenCalledTimes(1);

		rerender(inMap(<LocalMap nodes={withChangedVector(big)} />, store));
		expect(vi.mocked(buildMST)).toHaveBeenCalledTimes(2);
		expect(container.querySelectorAll("circle.node")).toHaveLength(200);
	});
});
