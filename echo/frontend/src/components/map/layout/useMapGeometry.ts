/**
 * The shared layout of a Map page: distances, exact MST, centre and LocalMap
 * neighbours, computed once per node set and budget, off the UI thread
 * where a Worker exists. Both renderers and the selection titles consume it.
 *
 * Keyed by the node set's geometry (revision ids plus a vector digest) and
 * the algorithm version. Over the node budget it refuses before any pairwise
 * work. While a new node set computes, `status` is "computing" and the edge
 * arrays are empty; the renderers keep drawing the last result they
 * accepted, so surviving nodes keep their positions and the zoom.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { LOCAL_MAP_SEED, type LocalMapNeighbours } from "../graph/localMap";
import { useGeometry } from "../renderers/hooks";
import type { Edge, MapGraphNode } from "../types";
import { LayoutClient } from "./client";
import {
	isValidNodeLimit,
	LAYOUT_ALGORITHM_VERSION,
	type LayoutTimings,
	overBudgetMessage,
	packVectors,
	runLayoutSync,
} from "./compute";
import { type GeometryResult, registerGeometryResult } from "./geometryResult";

export type MapGeometryStatus = "idle" | "computing" | "ready" | "error";

export type MapGeometry = {
	status: MapGeometryStatus;
	/** Id of the request this state belongs to (0 when none was needed). */
	requestId: number;
	/** Tree edges; empty unless ready. */
	mstEdges: Edge[];
	/** Graph centre (minimum eccentricity); null unless ready. */
	centerId: string | null;
	/** LocalMap neighbour and further pairs; empty unless ready. */
	neighbours: LocalMapNeighbours;
	error?: string;
	/** Geometry key of the node set this state is for; null when idle. */
	key: string | null;
	/** Active computation time of the result, when ready. */
	timings?: LayoutTimings;
};

export type UseMapGeometryOptions = {
	nodeLimit: number;
	/** Injected client (tests); the hook creates its own otherwise. */
	client?: LayoutClient;
};

export const EMPTY_EDGES: Edge[] = [];
export const EMPTY_NEIGHBOURS: LocalMapNeighbours = {
	fpLinks: [],
	nnLinks: [],
};

/** Request key: algorithm version, random-pair seed and node geometry. */
export const layoutRequestKey = (geometryKey: string) =>
	`${LAYOUT_ALGORITHM_VERSION}:${LOCAL_MAP_SEED}|${geometryKey}`;

type SyncOutcome =
	| { geometry: GeometryResult; timings: LayoutTimings }
	| { error: string };

const IDLE: MapGeometry = {
	centerId: null,
	key: null,
	mstEdges: EMPTY_EDGES,
	neighbours: EMPTY_NEIGHBOURS,
	requestId: 0,
	status: "idle",
};

export function useMapGeometry(
	nodes: MapGraphNode[],
	options: UseMapGeometryOptions,
): MapGeometry {
	const { nodeLimit, client: injectedClient } = options;
	const { key: geometryKey, nodes: geometryNodes } = useGeometry(nodes);
	const [ownClient] = useState(() => injectedClient ?? new LayoutClient());
	const client = injectedClient ?? ownClient;

	const count = geometryNodes.length;
	const overBudget = !isValidNodeLimit(nodeLimit) || count > nodeLimit;
	const requestKey = layoutRequestKey(geometryKey);
	// One node or none needs no pairwise work; without a Worker the
	// computation runs here, during render, so jsdom renders a ready map.
	const inline = count < 2 || !client.usesWorker();

	const syncOutcome = useMemo((): SyncOutcome | null => {
		if (!inline || overBudget || count === 0) return null;
		try {
			const result = runLayoutSync({
				...packVectors(geometryNodes),
				nodeLimit,
			});
			return {
				geometry: registerGeometryResult({
					centerId: result.centerId,
					key: geometryKey,
					mstEdges: result.mstEdges,
					neighbours: result.neighbours,
				}),
				timings: result.timings,
			};
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error) };
		}
	}, [inline, overBudget, count, geometryNodes, nodeLimit, geometryKey]);

	const snapshot = useSyncExternalStore(
		client.subscribe,
		client.getSnapshot,
		client.getSnapshot,
	);

	useEffect(() => {
		if (inline || overBudget) {
			client.cancel();
			return;
		}
		client.request({
			geometryKey,
			key: requestKey,
			nodeLimit,
			nodes: geometryNodes,
		});
		return () => client.cancel();
	}, [
		client,
		inline,
		overBudget,
		requestKey,
		geometryKey,
		geometryNodes,
		nodeLimit,
	]);

	useEffect(() => () => client.dispose(), [client]);

	return useMemo((): MapGeometry => {
		if (count === 0) return IDLE;
		const base = {
			centerId: null,
			key: geometryKey,
			mstEdges: EMPTY_EDGES,
			neighbours: EMPTY_NEIGHBOURS,
			requestId: snapshot.requestId,
		};
		if (overBudget) {
			return {
				...base,
				error: overBudgetMessage(count, nodeLimit),
				status: "error",
			};
		}
		if (syncOutcome) {
			if ("error" in syncOutcome) {
				return { ...base, error: syncOutcome.error, status: "error" };
			}
			return {
				...base,
				centerId: syncOutcome.geometry.centerId,
				mstEdges: syncOutcome.geometry.mstEdges,
				neighbours: syncOutcome.geometry.neighbours,
				status: "ready",
				timings: syncOutcome.timings,
			};
		}
		const { ready, error } = snapshot;
		if (ready?.key === requestKey) {
			return {
				...base,
				centerId: ready.geometry.centerId,
				mstEdges: ready.geometry.mstEdges,
				neighbours: ready.geometry.neighbours,
				requestId: ready.requestId,
				status: "ready",
				timings: ready.result.timings,
			};
		}
		if (error?.key === requestKey && snapshot.pendingKey !== requestKey) {
			return {
				...base,
				error: error.message,
				requestId: error.requestId,
				status: "error",
			};
		}
		return { ...base, status: "computing" };
	}, [
		count,
		geometryKey,
		overBudget,
		nodeLimit,
		syncOutcome,
		snapshot,
		requestKey,
	]);
}
