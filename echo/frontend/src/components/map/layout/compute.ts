/**
 * The layout computation both renderers and titles share: pairwise cosine
 * distances, the exact minimum spanning tree (Kruskal, as buildMST), the
 * graph centre and the LocalMap neighbour pairs, computed once per request.
 *
 * Written as a generator so one implementation runs in two drivers: the
 * layout worker, which pauses at the yields to take newer requests and
 * cancellations, and runLayoutSync, the fallback where no Worker exists.
 * Plain functions over typed arrays; no DOM, no d3.
 */
import {
	computeAdaptiveNeighbors,
	LOCAL_MAP_SEED,
	type LocalMapNeighbours,
	localMapLinksFromNeighbours,
	type NeighbourList,
	seededRandom,
} from "../graph/localMap";
import type { Edge } from "../types";

/**
 * Version of the layout algorithms and their parameters (distance formula,
 * MST tie order, neighbour count, random-pair seed). Part of every request
 * key; bump it when any of them changes.
 */
export const LAYOUT_ALGORITHM_VERSION = "map-layout-v1";

export type PackedVectors = {
	ids: string[];
	dims: number;
	/** Row-major, ids.length x dims, the exact float64 values of the embeddings. */
	vectors: Float64Array;
};

export type LayoutInput = PackedVectors & {
	nodeLimit: number;
	seed?: number;
};

export type LayoutTimings = {
	distancesMs: number;
	mstMs: number;
	centerMs: number;
	neighboursMs: number;
	/** Active computation time, without pauses in the worker. */
	totalMs: number;
};

export type LayoutOutput = {
	mstEdges: Edge[];
	centerId: string | null;
	neighbours: LocalMapNeighbours;
	timings: LayoutTimings;
	/** Bytes of the typed arrays the computation allocated. */
	workingBytes: number;
};

/** Where a paused computation is; the driver passes the pause length back in. */
export type LayoutPhase = "distances" | "mst" | "center" | "neighbours";

/** Refusal of a node set over its node budget, raised before any pairwise work. */
export class LayoutBudgetError extends Error {
	readonly nodeCount: number;
	readonly nodeLimit: number;

	constructor(nodeCount: number, nodeLimit: number) {
		super(overBudgetMessage(nodeCount, nodeLimit));
		this.name = "LayoutBudgetError";
		this.nodeCount = nodeCount;
		this.nodeLimit = nodeLimit;
	}
}

export const overBudgetMessage = (nodeCount: number, nodeLimit: number) =>
	`The map has ${nodeCount} nodes, over its node budget of ${nodeLimit}; the layout was not computed.`;

/** True for a node budget the layout accepts: a positive integer. */
export const isValidNodeLimit = (nodeLimit: number) =>
	Number.isInteger(nodeLimit) && nodeLimit > 0;

const now = () => performance.now();

/**
 * Copies embeddings into one Float64Array (transferable to the worker).
 * Throws when vectors differ in length; validate.ts keeps those off the map.
 */
export function packVectors(
	nodes: ReadonlyArray<{ id: string; embedding: ReadonlyArray<number> }>,
): PackedVectors {
	const n = nodes.length;
	const dims = n > 0 ? nodes[0].embedding.length : 0;
	const vectors = new Float64Array(n * dims);
	const ids = new Array<string>(n);
	for (let i = 0; i < n; i++) {
		const { id, embedding } = nodes[i];
		if (embedding.length !== dims) {
			throw new Error(
				`Embedding of ${id} has ${embedding.length} dimensions, expected ${dims}`,
			);
		}
		ids[i] = id;
		vectors.set(embedding, i * dims);
	}
	return { dims, ids, vectors };
}

const EMPTY_TIMINGS: LayoutTimings = {
	centerMs: 0,
	distancesMs: 0,
	mstMs: 0,
	neighboursMs: 0,
	totalMs: 0,
};

/**
 * The computation as resumable steps. Each `yield` is a point where the
 * driver may pause; `next(pausedMs)` reports how long it paused, so the
 * timings count active work only.
 */
export function* layoutSteps(
	input: LayoutInput,
): Generator<LayoutPhase, LayoutOutput, number | undefined> {
	const { ids, dims, vectors, nodeLimit, seed = LOCAL_MAP_SEED } = input;
	const n = ids.length;

	// The budget comes first: nothing pairwise is allocated or computed over it
	if (!isValidNodeLimit(nodeLimit) || n > nodeLimit) {
		throw new LayoutBudgetError(n, nodeLimit);
	}

	if (n < 2) {
		return {
			centerId: n === 1 ? ids[0] : null,
			mstEdges: [],
			neighbours: { fpLinks: [], nnLinks: [] },
			timings: EMPTY_TIMINGS,
			workingBytes: 0,
		};
	}

	let paused = 0;
	const started = now();
	const activeSince = (since: number, pausedAtStart: number) =>
		now() - since - (paused - pausedAtStart);

	// Distances: the exact arithmetic of cosineDistance in mst.ts (same
	// summation order, dot / (sqrt(normA) * sqrt(normB))), so the tree is
	// identical to buildMST's. A zero vector counts as maximally distant.
	let phaseStart = now();
	let pausedAtPhase = paused;
	const norms = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		const offset = i * dims;
		let sum = 0;
		for (let d = 0; d < dims; d++) {
			const value = vectors[offset + d];
			sum += value * value;
		}
		norms[i] = Math.sqrt(sum);
	}

	const pairCount = (n * (n - 1)) / 2;
	const rowStart = new Float64Array(n);
	const distances = new Float64Array(pairCount);
	let p = 0;
	for (let i = 0; i < n; i++) {
		rowStart[i] = p - (i + 1);
		const offsetI = i * dims;
		const normI = norms[i];
		for (let j = i + 1; j < n; j++) {
			const offsetJ = j * dims;
			let dot = 0;
			for (let d = 0; d < dims; d++) {
				dot += vectors[offsetI + d] * vectors[offsetJ + d];
			}
			const normJ = norms[j];
			distances[p++] =
				normI === 0 || normJ === 0 ? 1 : 1 - dot / (normI * normJ);
		}
		paused += (yield "distances") ?? 0;
	}
	// Index of pair (i, j), i < j: rowStart[i] + j
	const pairIndex = (i: number, j: number) =>
		i < j ? rowStart[i] + j : rowStart[j] + i;
	const distancesMs = activeSince(phaseStart, pausedAtPhase);

	// Kruskal: pairs by distance, ties in pair order (i < j, row by row), the
	// order buildMST's stable sort gives
	phaseStart = now();
	pausedAtPhase = paused;
	const order = new Uint32Array(pairCount);
	for (let q = 0; q < pairCount; q++) order[q] = q;
	order.sort((a, b) => distances[a] - distances[b] || a - b);
	paused += (yield "mst") ?? 0;

	const parent = new Int32Array(n);
	const rank = new Uint8Array(n);
	for (let i = 0; i < n; i++) parent[i] = i;
	const find = (x: number) => {
		let root = x;
		while (parent[root] !== root) root = parent[root];
		let node = x;
		while (parent[node] !== root) {
			const next = parent[node];
			parent[node] = root;
			node = next;
		}
		return root;
	};
	// Row of a pair index: the last i whose row starts at or before it
	const rowOf = (pair: number) => {
		let low = 0;
		let high = n - 2;
		while (low < high) {
			const mid = (low + high + 1) >> 1;
			if (rowStart[mid] + mid + 1 <= pair) low = mid;
			else high = mid - 1;
		}
		return low;
	};

	const mstEdges: Edge[] = [];
	const edgeFrom = new Int32Array(n - 1);
	const edgeTo = new Int32Array(n - 1);
	for (let q = 0; q < pairCount && mstEdges.length < n - 1; q++) {
		const pair = order[q];
		const i = rowOf(pair);
		const j = pair - rowStart[i];
		const rootI = find(i);
		const rootJ = find(j);
		if (rootI === rootJ) continue;
		if (rank[rootI] < rank[rootJ]) {
			parent[rootI] = rootJ;
		} else if (rank[rootI] > rank[rootJ]) {
			parent[rootJ] = rootI;
		} else {
			parent[rootJ] = rootI;
			rank[rootI]++;
		}
		edgeFrom[mstEdges.length] = i;
		edgeTo[mstEdges.length] = j;
		mstEdges.push({
			distance: distances[pair],
			source: ids[i],
			target: ids[j],
		});
	}
	const mstMs = activeSince(phaseStart, pausedAtPhase);
	paused += (yield "mst") ?? 0;

	// Centre: minimum eccentricity, the first node in order on ties (as findGraphCenter)
	phaseStart = now();
	pausedAtPhase = paused;
	const degree = new Int32Array(n + 1);
	for (let e = 0; e < n - 1; e++) {
		degree[edgeFrom[e] + 1]++;
		degree[edgeTo[e] + 1]++;
	}
	for (let i = 0; i < n; i++) degree[i + 1] += degree[i];
	const adjacency = new Int32Array(2 * (n - 1));
	const fill = degree.slice(0, n);
	for (let e = 0; e < n - 1; e++) {
		adjacency[fill[edgeFrom[e]]++] = edgeTo[e];
		adjacency[fill[edgeTo[e]]++] = edgeFrom[e];
	}
	const hops = new Int32Array(n);
	const queue = new Int32Array(n);
	let centerIndex = 0;
	let minEccentricity = Number.POSITIVE_INFINITY;
	for (let start = 0; start < n; start++) {
		hops.fill(-1);
		hops[start] = 0;
		queue[0] = start;
		let head = 0;
		let tail = 1;
		let eccentricity = 0;
		while (head < tail) {
			const node = queue[head++];
			const next = hops[node] + 1;
			for (let a = degree[node]; a < degree[node + 1]; a++) {
				const neighbour = adjacency[a];
				if (hops[neighbour] === -1) {
					hops[neighbour] = next;
					eccentricity = next;
					queue[tail++] = neighbour;
				}
			}
		}
		if (eccentricity < minEccentricity) {
			minEccentricity = eccentricity;
			centerIndex = start;
		}
		if ((start & 63) === 63) paused += (yield "center") ?? 0;
	}
	const centerMs = activeSince(phaseStart, pausedAtPhase);

	// LocalMap neighbours from the same distances: k nearest per node, ties in
	// node order (as computeKNN's stable sort), then the seeded random pairs
	phaseStart = now();
	pausedAtPhase = paused;
	const k = Math.min(computeAdaptiveNeighbors(n), n - 1);
	const bestIndex = new Int32Array(k);
	const bestDistance = new Float64Array(k);
	const knnMap = new Map<string, NeighbourList>();
	for (let i = 0; i < n; i++) {
		let filled = 0;
		for (let j = 0; j < n; j++) {
			if (j === i) continue;
			const distance = distances[pairIndex(i, j)];
			let position: number;
			if (filled < k) {
				position = filled++;
			} else if (distance < bestDistance[k - 1]) {
				position = k - 1;
			} else {
				continue;
			}
			while (position > 0 && bestDistance[position - 1] > distance) {
				bestDistance[position] = bestDistance[position - 1];
				bestIndex[position] = bestIndex[position - 1];
				position--;
			}
			bestDistance[position] = distance;
			bestIndex[position] = j;
		}
		const list: NeighbourList = new Array(filled);
		for (let t = 0; t < filled; t++) {
			list[t] = { distance: bestDistance[t], id: ids[bestIndex[t]] };
		}
		knnMap.set(ids[i], list);
		if ((i & 31) === 31) paused += (yield "neighbours") ?? 0;
	}
	const { nnLinks, fpLinks } = localMapLinksFromNeighbours(
		ids.map((id) => ({ id })),
		knnMap,
		k,
		0.2,
		2.0,
		seededRandom(seed),
	);
	const neighboursMs = activeSince(phaseStart, pausedAtPhase);

	const workingBytes =
		norms.byteLength +
		rowStart.byteLength +
		distances.byteLength +
		order.byteLength +
		parent.byteLength +
		rank.byteLength +
		edgeFrom.byteLength +
		edgeTo.byteLength +
		degree.byteLength +
		adjacency.byteLength +
		fill.byteLength +
		hops.byteLength +
		queue.byteLength +
		bestIndex.byteLength +
		bestDistance.byteLength;

	return {
		centerId: ids[centerIndex],
		mstEdges,
		neighbours: { fpLinks, nnLinks },
		timings: {
			centerMs,
			distancesMs,
			mstMs,
			neighboursMs,
			totalMs: activeSince(started, 0),
		},
		workingBytes,
	};
}

/** Runs the whole computation at once, on the calling thread. */
export function runLayoutSync(input: LayoutInput): LayoutOutput {
	const steps = layoutSteps(input);
	for (;;) {
		const step = steps.next(0);
		if (step.done) return step.value;
	}
}
