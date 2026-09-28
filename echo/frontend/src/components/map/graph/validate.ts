import type { MapGraphNode } from "../types";

export type EmbeddingRejection =
	| "missing"
	| "non-finite"
	| "zero"
	| "dimension";

export type EmbeddingPartition = {
	valid: MapGraphNode[];
	invalid: { id: string; reason: EmbeddingRejection }[];
	/** Dimension of the first valid embedding, or null when none is valid. */
	dims: number | null;
};

/**
 * Splits nodes into those the map can place and those it cannot, with the
 * reason. Cosine distance is undefined for an empty, non-finite or zero
 * vector, and meaningless across vectors of different dimension.
 */
export function partitionByEmbedding(
	nodes: ReadonlyArray<MapGraphNode>,
): EmbeddingPartition {
	const valid: MapGraphNode[] = [];
	const invalid: EmbeddingPartition["invalid"] = [];
	let dims: number | null = null;

	for (const node of nodes) {
		const embedding: unknown = node.embedding;

		if (!Array.isArray(embedding) || embedding.length === 0) {
			invalid.push({ id: node.id, reason: "missing" });
			continue;
		}

		let finite = true;
		let normSquared = 0;
		for (const value of embedding) {
			if (typeof value !== "number" || !Number.isFinite(value)) {
				finite = false;
				break;
			}
			normSquared += value * value;
		}

		if (!finite) {
			invalid.push({ id: node.id, reason: "non-finite" });
			continue;
		}

		if (normSquared === 0) {
			invalid.push({ id: node.id, reason: "zero" });
			continue;
		}

		if (dims === null) {
			dims = embedding.length;
		} else if (embedding.length !== dims) {
			invalid.push({ id: node.id, reason: "dimension" });
			continue;
		}

		valid.push(node);
	}

	return { dims, invalid, valid };
}
