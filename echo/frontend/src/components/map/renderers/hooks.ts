import {
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { attributeInputsOf } from "../attributes";
import type { LocalMapNeighbours } from "../graph/localMap";
import { nodeGeometryKey } from "../graph/nodeSet";
import {
	getNodeStyleFromInputs,
	type NodeStyle,
	nodeSizeScale,
} from "../graph/nodeStyle";
import { type EdgeCounts, edgeCountsEqual } from "../layout/edgeBudget";
import { geometryResultOf } from "../layout/geometryResult";
import {
	type MapInteractionStore,
	useMapInteractionStore,
} from "../state/interactionStore";
import type { ColorBy, Edge, HighlightSource, MapGraphNode } from "../types";
import { d3, type Selection, type Timer } from "./d3";

/** Stable default for recentNodeIds, so a missing prop does not change identity per render. */
export const EMPTY_NODE_IDS: string[] = [];

export type MapSize = { width: number; height: number };

/** Size used until the container has been measured (and in jsdom, which has no layout). */
export const DEFAULT_MAP_SIZE: MapSize = { height: 600, width: 800 };

/**
 * The node array to key geometry work on (tree, neighbours, layout), with
 * its geometry key. Keeps the previous array while ids and vectors are
 * unchanged, so a refetch that only changes metadata or array identity does
 * not rebuild the graph. Size, colour and labels are not part of the key.
 *
 * Held in a ref rather than a useMemo keyed on the geometry: the build can
 * widen a memo's dependencies to everything its callback reads (here the
 * nodes array), which would hand back every new array.
 */
export function useGeometry<N extends MapGraphNode>(
	nodes: N[],
): { key: string; nodes: N[] } {
	const key = useMemo(() => nodeGeometryKey(nodes), [nodes]);
	const stableRef = useRef<{ key: string; nodes: N[] } | null>(null);
	if (stableRef.current === null || stableRef.current.key !== key) {
		stableRef.current = { key, nodes };
	}
	return stableRef.current;
}

/** The geometry-stable node array; see useGeometry. */
export function useGeometryNodes<N extends MapGraphNode>(nodes: N[]): N[] {
	return useGeometry(nodes).nodes;
}

/** What a renderer draws its geometry from. */
export type RendererGeometry<N> = {
	key: string;
	/** The node set the tree and neighbours belong to. */
	nodes: N[];
	mstEdges: Edge[];
	/** Graph centre when a layout result supplied it; undefined: find it. */
	centerId: string | null | undefined;
	neighbours: LocalMapNeighbours | null;
};

export type GeometryBuild = {
	mstEdges: Edge[];
	neighbours: LocalMapNeighbours | null;
};

const EMPTY_GEOMETRY: RendererGeometry<never> = {
	centerId: null,
	key: "",
	mstEdges: [],
	neighbours: null,
	nodes: [],
};

const spansNodes = (edges: ReadonlyArray<Edge>, ids: ReadonlySet<string>) =>
	edges.length === Math.max(0, ids.size - 1) &&
	edges.every((edge) => ids.has(edge.source) && ids.has(edge.target));

const linksWithin = (
	neighbours: LocalMapNeighbours,
	ids: ReadonlySet<string>,
) =>
	(ids.size < 2 || neighbours.nnLinks.length > 0) &&
	[...neighbours.nnLinks, ...neighbours.fpLinks].every(
		(link) => ids.has(link.source) && ids.has(link.target),
	);

/**
 * The geometry a renderer draws. Without provided geometry it builds its
 * own (the synchronous path). With a layout result (from useMapGeometry) it
 * uses the result only when it belongs to the current node set; with arrays
 * the caller built, only when they span the current nodes. Until a matching
 * result arrives it keeps drawing the last geometry it accepted, so a
 * filter never shows a tree over the wrong nodes and surviving nodes keep
 * their place.
 */
export function useRendererGeometry<N extends MapGraphNode>(
	nodes: N[],
	provided: { mstEdges?: Edge[]; neighbours?: LocalMapNeighbours },
	build: (nodes: ReadonlyArray<N>) => GeometryBuild,
): RendererGeometry<N> {
	const { key, nodes: geometryNodes } = useGeometry(nodes);
	const { mstEdges: providedEdges, neighbours: providedNeighbours } = provided;
	const isProvided =
		providedEdges !== undefined || providedNeighbours !== undefined;

	const own = useMemo(
		() => (isProvided ? null : build(geometryNodes)),
		[isProvided, build, geometryNodes],
	);

	const resolved = useMemo((): RendererGeometry<N> | null => {
		if (own) {
			return {
				centerId: undefined,
				key,
				mstEdges: own.mstEdges,
				neighbours: own.neighbours,
				nodes: geometryNodes,
			};
		}
		const result = geometryResultOf(providedEdges ?? providedNeighbours);
		if (result) {
			if (result.key !== key) return null;
			return {
				centerId: result.centerId,
				key,
				mstEdges: result.mstEdges,
				neighbours: result.neighbours,
				nodes: geometryNodes,
			};
		}
		const ids = new Set(geometryNodes.map((node) => node.id));
		if (providedEdges && !spansNodes(providedEdges, ids)) return null;
		if (providedNeighbours && !linksWithin(providedNeighbours, ids)) {
			return null;
		}
		return {
			centerId: undefined,
			key,
			mstEdges: providedEdges ?? [],
			neighbours: providedNeighbours ?? null,
			nodes: geometryNodes,
		};
	}, [own, key, geometryNodes, providedEdges, providedNeighbours]);

	const acceptedRef = useRef<RendererGeometry<N>>(EMPTY_GEOMETRY);
	if (resolved) acceptedRef.current = resolved;
	return resolved ?? acceptedRef.current;
}

/** Node style by id, computed once per nodes and colour inputs. */
export function useNodeStyleLookup(
	nodes: MapGraphNode[],
	colorBy: ColorBy,
	darkMode: boolean,
): (id: string) => NodeStyle {
	return useMemo(() => {
		const options = { colorBy, darkMode };
		const styleById = new Map<string, NodeStyle>();
		for (const node of nodes) {
			styleById.set(
				node.id,
				getNodeStyleFromInputs(attributeInputsOf(node.metadata), options),
			);
		}
		const fallback = getNodeStyleFromInputs({}, options);
		return (id: string) => styleById.get(id) ?? fallback;
	}, [nodes, colorBy, darkMode]);
}

export type NodeRadius = {
	/** Base radius times the node's size scale (tension 1.5). */
	radiusOf: (id: string) => number;
	/** Changes exactly when some node's radius changes. */
	signature: string;
};

/**
 * Per-node radius from each node's size scale. Circle radius, collision,
 * auto-fit padding and the hover reach all read it; the geometry key does
 * not, so a size change updates those in place.
 */
export function useNodeRadius(
	nodes: ReadonlyArray<MapGraphNode>,
	baseRadius: number,
): NodeRadius {
	return useMemo(() => {
		const scaled = new Map<string, number>();
		const parts: string[] = [];
		for (const node of nodes) {
			const scale = nodeSizeScale(node);
			if (scale !== 1) {
				scaled.set(node.id, baseRadius * scale);
				parts.push(`${node.id}:${scale}`);
			}
		}
		return {
			radiusOf: (id: string) => scaled.get(id) ?? baseRadius,
			signature: `${baseRadius}|${parts.join(",")}`,
		};
	}, [nodes, baseRadius]);
}

/** Calls onEdgeCounts when the drawn or available connection counts change. */
export function useReportEdgeCounts(
	counts: EdgeCounts,
	onEdgeCounts: ((counts: EdgeCounts) => void) | undefined,
) {
	const reportedRef = useRef<EdgeCounts | null>(null);
	useEffect(() => {
		if (!onEdgeCounts) return;
		const reported = reportedRef.current;
		if (reported && edgeCountsEqual(reported, counts)) return;
		reportedRef.current = counts;
		onEdgeCounts(counts);
	}, [counts, onEdgeCounts]);
}

/**
 * Container size from a ResizeObserver. `sizeRef` always holds the latest
 * size; `measure()` reads the container synchronously (so a simulation can be
 * created at the real size) and returns it.
 */
export function useContainerSize(containerRef: RefObject<HTMLElement | null>): {
	size: MapSize;
	sizeRef: RefObject<MapSize>;
	measure: () => MapSize;
} {
	const [size, setSize] = useState<MapSize>(DEFAULT_MAP_SIZE);
	const sizeRef = useRef<MapSize>(size);

	const update = useCallback((width: number, height: number) => {
		if (!(width > 0 && height > 0)) return;
		const current = sizeRef.current;
		if (current.width === width && current.height === height) return;
		const next = { height, width };
		sizeRef.current = next;
		setSize(next);
	}, []);

	const measure = useCallback((): MapSize => {
		const element = containerRef.current;
		if (element) {
			const rect = element.getBoundingClientRect();
			update(rect.width, rect.height);
		}
		return sizeRef.current;
	}, [containerRef, update]);

	useEffect(() => {
		const element = containerRef.current;
		if (!element) return;

		const observer = new ResizeObserver((entries) => {
			const entry = entries[0];
			if (!entry) return;
			update(entry.contentRect.width, entry.contentRect.height);
		});

		observer.observe(element);
		return () => observer.disconnect();
	}, [containerRef, update]);

	return { measure, size, sizeRef };
}

const releaseHighlight = (
	store: MapInteractionStore,
	source: HighlightSource,
) => {
	store.setHighlightedNodeIds(new Set(), { isPreview: false, source });
	store.setHighlightedNodesDistance(new Map());
};

/**
 * Clears the store highlight a renderer published as `source` when one of
 * its nodes leaves the node set (an empty set included) and when the
 * renderer unmounts, so the other renderers stop outlining nodes that are
 * gone. Highlights from other sources are left alone.
 */
export function useReleaseOwnedHighlight(
	source: HighlightSource,
	nodes: ReadonlyArray<{ id: string }>,
) {
	const store = useMapInteractionStore();

	useEffect(() => {
		const { highlightSource, highlightedNodeIds } = store.getState();
		if (highlightSource !== source || highlightedNodeIds.size === 0) return;
		const present = new Set(nodes.map((node) => node.id));
		for (const id of highlightedNodeIds) {
			if (!present.has(id)) {
				releaseHighlight(store, source);
				return;
			}
		}
	}, [store, source, nodes]);

	useEffect(() => {
		return () => {
			const { highlightSource, highlightedNodeIds } = store.getState();
			if (highlightSource === source && highlightedNodeIds.size > 0) {
				releaseHighlight(store, source);
			}
		};
	}, [store, source]);
}

/** Opacity of an in-flight fact-check: 0.5 + 0.5 x |sin(t / 400)|. */
const pulseOpacity = () =>
	0.5 + 0.5 * Math.abs(Math.sin(performance.now() / 400));

/**
 * Pulses the circles in `pulseSelectionRef` on a d3 timer of its own, not the
 * simulation tick, so in-flight fact-checks keep pulsing while the physics is
 * paused or settled. Call the returned function after the pulse selection
 * changes: it starts the timer when something pulses. The timer stops itself
 * once nothing does, and on unmount.
 */
export function usePulseTimer<D>(
	pulseSelectionRef: RefObject<Selection<
		SVGCircleElement,
		D,
		SVGGElement,
		unknown
	> | null>,
): () => void {
	const timerRef = useRef<Timer | null>(null);

	useEffect(() => {
		return () => {
			timerRef.current?.stop();
			timerRef.current = null;
		};
	}, []);

	return useCallback(() => {
		if (timerRef.current) return;
		const pulsing = pulseSelectionRef.current;
		if (!pulsing || pulsing.empty()) return;

		const timer = d3.timer(() => {
			const current = pulseSelectionRef.current;
			if (!current || current.empty()) {
				timer.stop();
				timerRef.current = null;
				return;
			}
			current.attr("opacity", pulseOpacity());
		});
		timerRef.current = timer;
	}, [pulseSelectionRef]);
}
