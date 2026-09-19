import type { LocalMapNeighbours } from "../graph/localMap";
import type { Edge } from "../types";

/** One layout result: the tree, centre and neighbours of one node set. */
export type GeometryResult = {
	/** nodeGeometryKey of the node set: revision ids plus a vector digest. */
	key: string;
	mstEdges: Edge[];
	centerId: string | null;
	neighbours: LocalMapNeighbours;
};

const resultByArtifact = new WeakMap<object, GeometryResult>();

/**
 * Remembers which result an edge array and neighbour object belong to. A
 * renderer handed `mstEdges` or `neighbours` from useMapGeometry looks the
 * result up to check that it belongs to the nodes it draws, so a result for
 * an older node set never replaces the graph.
 */
export function registerGeometryResult(result: GeometryResult): GeometryResult {
	resultByArtifact.set(result.mstEdges, result);
	resultByArtifact.set(result.neighbours, result);
	return result;
}

/** The result an edge array or neighbour object came from, if it was registered. */
export function geometryResultOf(
	artifact: object | undefined,
): GeometryResult | undefined {
	return artifact ? resultByArtifact.get(artifact) : undefined;
}
