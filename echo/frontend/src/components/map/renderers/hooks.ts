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
import type { ColorBy, MapGraphNode } from "../types";

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
