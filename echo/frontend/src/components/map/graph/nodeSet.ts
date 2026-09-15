import type { MapGraphNode } from "../types";

type EmbeddedNode = { id: string; embedding: ReadonlyArray<number> };

/**
 * Key for the geometry of a node set: ids in order plus a checksum over every
 * component of every vector. Two node arrays with the same key produce the
 * same tree, neighbours and layout, so geometry work can be keyed on it.
 */
export function nodeGeometryKey(nodes: ReadonlyArray<EmbeddedNode>): string {
	const parts = new Array<string>(nodes.length);
	for (let n = 0; n < nodes.length; n++) {
		const { id, embedding } = nodes[n];
		let sum = 0;
		let weighted = 0;
		let squares = 0;
		for (let i = 0; i < embedding.length; i++) {
			const value = embedding[i];
			sum += value;
			weighted += value * (i + 1);
			squares += value * value;
		}
		parts[n] = `${id}:${embedding.length}:${sum}:${weighted}:${squares}`;
	}
	return parts.join("|");
}

/** Ids of the newest nodes by createdAt, newest first; nodes without a date are skipped. */
export function newestNodeIds(
	nodes: ReadonlyArray<Pick<MapGraphNode, "id" | "metadata">>,
	count = 10,
): string[] {
	return nodes
		.map((node) => {
			const createdAt = node.metadata?.createdAt;
			const timestamp =
				typeof createdAt === "string" ? Date.parse(createdAt) : Number.NaN;
			return { id: node.id, timestamp };
		})
		.filter(({ timestamp }) => Number.isFinite(timestamp))
		.sort((a, b) => b.timestamp - a.timestamp)
		.slice(0, count)
		.map(({ id }) => id);
}
