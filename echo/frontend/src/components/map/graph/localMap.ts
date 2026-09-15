/**
 * LocalMAP force pairs (https://arxiv.org/pdf/2412.15426): nearest-neighbour
 * pairs attract strongly, mid-near pairs attract weakly, further pairs repel.
 */

type EmbeddedNode = { id: string; embedding: number[] };

export type LocalMapLink = { source: string; target: string; strength: number };

export type NeighbourList = Array<{ id: string; distance: number }>;

/** Adaptive number of neighbours for a dataset of n points. */
export function computeAdaptiveNeighbors(n: number): number {
	if (n < 10000) {
		return Math.min(10, n - 1);
	}
	return Math.floor(10 + 15 * (Math.log10(n) - 4));
}

/** k nearest neighbours per node by cosine distance on normalised vectors. */
export function computeKNN(
	nodes: ReadonlyArray<EmbeddedNode>,
	k: number,
): Map<string, NeighbourList> {
	const knnMap = new Map<string, NeighbourList>();

	const normalizedEmbeddings = nodes.map((node) => {
		const norm = Math.sqrt(
			node.embedding.reduce((sum, val) => sum + val * val, 0),
		);
		return norm > 0 ? node.embedding.map((val) => val / norm) : node.embedding;
	});

	for (let i = 0; i < nodes.length; i++) {
		const nodeA = nodes[i];
		const embeddingA = normalizedEmbeddings[i];
		const distances: NeighbourList = [];

		for (let j = 0; j < nodes.length; j++) {
			if (i !== j) {
				const nodeB = nodes[j];
				const embeddingB = normalizedEmbeddings[j];

				let dotProduct = 0;
				for (let idx = 0; idx < embeddingA.length; idx++) {
					dotProduct += embeddingA[idx] * embeddingB[idx];
				}
				const distance = 1 - dotProduct;

				distances.push({ distance, id: nodeB.id });
			}
		}

		distances.sort((a, b) => a.distance - b.distance);
		knnMap.set(nodeA.id, distances.slice(0, k));
	}

	return knnMap;
}

/** Random pairs that are not k-NN pairs (in either direction). */
export function generateMidNearPairs(
	nodes: ReadonlyArray<EmbeddedNode>,
	knnMap: Map<string, NeighbourList>,
	mnCount: number,
	random: () => number = Math.random,
): Array<{ source: string; target: string }> {
	const pairs: Array<{ source: string; target: string }> = [];
	const knnPairSet = new Set<string>();

	for (const [nodeId, neighbors] of knnMap.entries()) {
		for (const neighbor of neighbors) {
			knnPairSet.add(`${nodeId}-${neighbor.id}`);
			knnPairSet.add(`${neighbor.id}-${nodeId}`);
		}
	}

	const targetCount = Math.min(
		mnCount,
		(nodes.length * (nodes.length - 1)) / 2,
	);
	let attempts = 0;
	const maxAttempts = targetCount * 10;

	while (pairs.length < targetCount && attempts < maxAttempts) {
		const i = Math.floor(random() * nodes.length);
		const j = Math.floor(random() * nodes.length);

		if (i !== j) {
			const pairKey = `${nodes[i].id}-${nodes[j].id}`;
			if (!knnPairSet.has(pairKey)) {
				pairs.push({
					source: nodes[i].id,
					target: nodes[j].id,
				});
				knnPairSet.add(pairKey);
				knnPairSet.add(`${nodes[j].id}-${nodes[i].id}`);
			}
		}

		attempts++;
	}

	return pairs;
}

/** Random pairs for repulsion; draws that land on the same node are skipped. */
export function generateFurtherPairs(
	nodes: ReadonlyArray<EmbeddedNode>,
	fpCount: number,
	random: () => number = Math.random,
): Array<{ source: string; target: string }> {
	const pairs: Array<{ source: string; target: string }> = [];
	const targetCount = Math.min(
		fpCount,
		(nodes.length * (nodes.length - 1)) / 2,
	);

	for (let i = 0; i < targetCount; i++) {
		const a = Math.floor(random() * nodes.length);
		const b = Math.floor(random() * nodes.length);
		if (a !== b) {
			pairs.push({
				source: nodes[a].id,
				target: nodes[b].id,
			});
		}
	}

	return pairs;
}

/** NN, mid-near and further-pair links for the LocalMap simulation. */
export function buildLocalMapForces(
	nodes: ReadonlyArray<EmbeddedNode>,
	mnRatio = 0.2,
	fpRatio = 2.0,
	random: () => number = Math.random,
): {
	nnLinks: LocalMapLink[];
	mnLinks: LocalMapLink[];
	fpLinks: LocalMapLink[];
} {
	if (nodes.length < 2) {
		return {
			fpLinks: [],
			mnLinks: [],
			nnLinks: [],
		};
	}

	const k = computeAdaptiveNeighbors(nodes.length);
	const actualK = Math.min(k, nodes.length - 1);

	const knnMap = computeKNN(nodes, actualK);

	// Nearest neighbour links (strong attraction)
	const nnLinks: LocalMapLink[] = [];
	for (const [sourceId, neighbors] of knnMap.entries()) {
		for (const neighbor of neighbors) {
			nnLinks.push({
				source: sourceId,
				strength: 1.0,
				target: neighbor.id,
			});
		}
	}

	// Mid-near links (weak attraction)
	const mnCount = Math.floor(actualK * mnRatio * nodes.length);
	const mnPairs = generateMidNearPairs(nodes, knnMap, mnCount, random);
	const mnLinks: LocalMapLink[] = mnPairs.map((pair) => ({
		source: pair.source,
		strength: 0.1,
		target: pair.target,
	}));

	// Further pair links (repulsion)
	const fpCount = Math.floor(actualK * fpRatio * nodes.length);
	const fpPairs = generateFurtherPairs(nodes, fpCount, random);
	const fpLinks: LocalMapLink[] = fpPairs.map((pair) => ({
		source: pair.source,
		strength: -0.5,
		target: pair.target,
	}));

	return {
		fpLinks,
		mnLinks,
		nnLinks,
	};
}
