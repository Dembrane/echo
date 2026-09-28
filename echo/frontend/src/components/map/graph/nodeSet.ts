import type { MapGraphNode } from "../types";

type EmbeddedNode = { id: string; embedding: ReadonlyArray<number> };

/**
 * Key for the geometry of a node set: ids in order plus a hash of the exact
 * bytes of every component of every vector. Two node arrays with the same key
 * produce the same tree, neighbours and layout, so geometry work can be keyed
 * on it.
 *
 * Checksums of sums collide ([0, 0, 0, 10] and [1, -3, 3, 9] share length,
 * sum, weighted sum and sum of squares), so the Float64 bytes go through two
 * FNV-1a style hashes with different offsets and multipliers. About 3 ms for
 * 200 nodes of 768 dimensions.
 */
export function nodeGeometryKey(nodes: ReadonlyArray<EmbeddedNode>): string {
	const parts = new Array<string>(nodes.length);
	let values = new Float64Array(0);
	let bytes = new Uint8Array(0);
	for (let n = 0; n < nodes.length; n++) {
		const { id, embedding } = nodes[n];
		if (values.length < embedding.length) {
			values = new Float64Array(embedding.length);
			bytes = new Uint8Array(values.buffer);
		}
		for (let i = 0; i < embedding.length; i++) {
			values[i] = embedding[i];
		}
		let h1 = 0x811c9dc5;
		let h2 = 0x1b873593;
		const byteLength = embedding.length * 8;
		for (let b = 0; b < byteLength; b++) {
			const byte = bytes[b];
			h1 = Math.imul(h1 ^ byte, 0x01000193);
			h2 = Math.imul(h2 ^ byte, 0x85ebca77);
		}
		parts[n] =
			`${id}:${embedding.length}:${(h1 >>> 0).toString(36)}:${(h2 >>> 0).toString(36)}`;
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
