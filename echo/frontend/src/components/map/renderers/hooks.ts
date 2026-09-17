import {
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { nodeGeometryKey } from "../graph/nodeSet";
import { getNodeStyleFromInputs, type NodeStyle } from "../graph/nodeStyle";
import {
	type MapInteractionStore,
	useMapInteractionStore,
} from "../state/interactionStore";
import type { ColorBy, HighlightSource, MapGraphNode } from "../types";
import { d3, type Selection, type Timer } from "./d3";

/** Stable default for recentNodeIds, so a missing prop does not change identity per render. */
export const EMPTY_NODE_IDS: string[] = [];

export type MapSize = { width: number; height: number };

/** Size used until the container has been measured (and in jsdom, which has no layout). */
export const DEFAULT_MAP_SIZE: MapSize = { height: 600, width: 800 };

/**
 * The node array to key geometry work on (tree, neighbours, layout). Keeps
 * the previous array while ids and vectors are unchanged, so a refetch that
 * only changes metadata or array identity does not rebuild the graph.
 *
 * Held in a ref rather than a useMemo keyed on the geometry: the build can
 * widen a memo's dependencies to everything its callback reads (here the
 * nodes array), which would hand back every new array.
 */
export function useGeometryNodes<N extends MapGraphNode>(nodes: N[]): N[] {
	const key = useMemo(() => nodeGeometryKey(nodes), [nodes]);
	const stableRef = useRef<{ key: string; nodes: N[] } | null>(null);
	if (stableRef.current === null || stableRef.current.key !== key) {
		stableRef.current = { key, nodes };
	}
	return stableRef.current.nodes;
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
			const meta = node.metadata;
			styleById.set(
				node.id,
				getNodeStyleFromInputs(
					{
						factCheck: meta?.factCheck,
						kind: meta?.kind,
						valence: meta?.valence,
					},
					options,
				),
			);
		}
		const fallback = getNodeStyleFromInputs({}, options);
		return (id: string) => styleById.get(id) ?? fallback;
	}, [nodes, colorBy, darkMode]);
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
