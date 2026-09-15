import type { Edge } from "../types";

type IdNode = { id: string };
type EmbeddedNode = { id: string; embedding: number[] };

/**
 * Cosine distance between two embedding vectors (the MST map's variant).
 * Expects vectors of equal length with a non-zero norm; see validate.ts.
 */
export function cosineDistance(a: number[], b: number[]): number {
	let dotProduct = 0;
	let normA = 0;
	let normB = 0;

	for (let i = 0; i < a.length; i++) {
		dotProduct += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}

	const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
	return 1 - similarity;
}

/**
 * The LocalMap renderer's variant: compares the shared prefix and treats a
 * zero vector as maximally distant. On validated embeddings it returns the
 * same value as cosineDistance.
 */
export function cosineDistanceGuarded(a: number[], b: number[]): number {
	let dotProduct = 0;
	let normA = 0;
	let normB = 0;

	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		dotProduct += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}

	if (normA === 0 || normB === 0) return 1;

	const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
	return 1 - similarity;
}

/**
 * Minimum spanning tree over all node pairs by Kruskal's algorithm with
 * union-find (union by rank, path compression). Edges are sorted by distance
 * with a stable sort, so ties keep pair order (i < j, row by row).
 */
export function buildMST(
	nodes: ReadonlyArray<EmbeddedNode>,
	distance: (a: number[], b: number[]) => number = cosineDistance,
): Edge[] {
	const n = nodes.length;
	if (n < 2) return [];

	const edges: Edge[] = [];
	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) {
			edges.push({
				distance: distance(nodes[i].embedding, nodes[j].embedding),
				source: nodes[i].id,
				target: nodes[j].id,
			});
		}
	}

	edges.sort((a, b) => a.distance - b.distance);

	const parent = new Map<string, string>();
	const rank = new Map<string, number>();

	for (const node of nodes) {
		parent.set(node.id, node.id);
		rank.set(node.id, 0);
	}

	function find(x: string): string {
		if (parent.get(x) !== x) {
			parent.set(x, find(parent.get(x) as string));
		}
		return parent.get(x) as string;
	}

	function union(x: string, y: string): boolean {
		const px = find(x);
		const py = find(y);

		if (px === py) return false;

		const rx = rank.get(px) || 0;
		const ry = rank.get(py) || 0;

		if (rx < ry) {
			parent.set(px, py);
		} else if (rx > ry) {
			parent.set(py, px);
		} else {
			parent.set(py, px);
			rank.set(px, rx + 1);
		}

		return true;
	}

	const mst: Edge[] = [];
	for (const edge of edges) {
		if (union(edge.source, edge.target)) {
			mst.push(edge);
			if (mst.length === n - 1) break;
		}
	}

	return mst;
}

/** Undirected adjacency: every node gets an entry, edges add both directions. */
export function adjacencyOf(
	nodes: ReadonlyArray<IdNode>,
	edges: ReadonlyArray<Edge>,
): Map<string, Set<string>> {
	const adjacency = new Map<string, Set<string>>();
	for (const node of nodes) {
		adjacency.set(node.id, new Set());
	}
	for (const edge of edges) {
		adjacency.get(edge.source)?.add(edge.target);
		adjacency.get(edge.target)?.add(edge.source);
	}
	return adjacency;
}

/** Breadth-first hop counts from one node to every reachable node. */
function hopsFrom(
	startId: string,
	adjacency: Map<string, Set<string>>,
): Map<string, number> {
	const distances = new Map<string, number>();
	const queue: { id: string; distance: number }[] = [
		{ distance: 0, id: startId },
	];
	const visited = new Set<string>([startId]);
	distances.set(startId, 0);

	let head = 0;
	while (head < queue.length) {
		const { id, distance } = queue[head++];

		const neighbors = adjacency.get(id) || new Set<string>();
		for (const neighborId of neighbors) {
			if (!visited.has(neighborId)) {
				visited.add(neighborId);
				const newDistance = distance + 1;
				distances.set(neighborId, newDistance);
				queue.push({ distance: newDistance, id: neighborId });
			}
		}
	}

	return distances;
}

/** Hop distance along the tree between every pair of nodes. */
export function mstHopDistances(
	nodes: ReadonlyArray<IdNode>,
	edges: ReadonlyArray<Edge>,
): Map<string, Map<string, number>> {
	const adjacency = adjacencyOf(nodes, edges);
	const distances = new Map<string, Map<string, number>>();
	for (const startNode of nodes) {
		distances.set(startNode.id, hopsFrom(startNode.id, adjacency));
	}
	return distances;
}

/** Eccentricity (largest hop distance to a reachable node) per node. */
export function eccentricities(
	nodes: ReadonlyArray<IdNode>,
	edges: ReadonlyArray<Edge>,
): Map<string, number> {
	const adjacency = adjacencyOf(nodes, edges);
	const result = new Map<string, number>();
	for (const node of nodes) {
		const distances = hopsFrom(node.id, adjacency);
		result.set(node.id, Math.max(...Array.from(distances.values())));
	}
	return result;
}

/**
 * Graph centre: the node with minimum eccentricity. Nodes are visited in
 * array order and only a strictly smaller eccentricity replaces the current
 * pick, so the first node wins ties.
 */
export function findGraphCenter(
	nodes: ReadonlyArray<IdNode>,
	edges: ReadonlyArray<Edge>,
): string | null {
	if (nodes.length === 0) return null;
	if (nodes.length === 1) return nodes[0].id;

	const adjacency = adjacencyOf(nodes, edges);
	let rootId = nodes[0].id;
	let minEccentricity = Number.POSITIVE_INFINITY;

	for (const startNode of nodes) {
		const distances = hopsFrom(startNode.id, adjacency);
		const eccentricity = Math.max(...Array.from(distances.values()));

		if (eccentricity < minEccentricity) {
			minEccentricity = eccentricity;
			rootId = startNode.id;
		}
	}

	return rootId;
}

/** The tree rooted at the graph centre: each node's parent and children. */
export type RootedTree = {
	rootId: string | null;
	parent: Map<string, string | null>;
	children: Map<string, string[]>;
};

/**
 * Roots the tree at the graph centre by BFS. Build it once per node set and
 * look up subtrees with descendantsOf.
 */
export function buildRootedTree(
	nodes: ReadonlyArray<IdNode>,
	edges: ReadonlyArray<Edge>,
): RootedTree {
	const parent = new Map<string, string | null>();
	const children = new Map<string, string[]>();

	const rootId = findGraphCenter(nodes, edges);
	if (!rootId) return { children, parent, rootId };

	const adjacency = adjacencyOf(nodes, edges);
	const visited = new Set<string>([rootId]);
	const queue: string[] = [rootId];
	parent.set(rootId, null);

	let head = 0;
	while (head < queue.length) {
		const id = queue[head++];
		const nodeChildren: string[] = [];
		for (const neighborId of adjacency.get(id) ?? []) {
			if (!visited.has(neighborId)) {
				visited.add(neighborId);
				parent.set(neighborId, id);
				nodeChildren.push(neighborId);
				queue.push(neighborId);
			}
		}
		children.set(id, nodeChildren);
	}

	return { children, parent, rootId };
}

/**
 * The hovered node and everything below it in a rooted tree. Distances are
 * depth / 4, capped at 1 (0 for the hovered node).
 */
export function descendantsOf(
	hoveredId: string,
	tree: RootedTree,
): { ids: Set<string>; distances: Map<string, number> } {
	const ids = new Set<string>();
	const distances = new Map<string, number>();
	if (!tree.rootId) return { distances, ids };

	const queue: { id: string; depth: number }[] = [{ depth: 0, id: hoveredId }];
	ids.add(hoveredId);

	let head = 0;
	while (head < queue.length) {
		const { id, depth } = queue[head++];
		// depth 0 = 0, depth 4 and beyond = 1
		distances.set(id, Math.min(depth / 4, 1.0));

		for (const childId of tree.children.get(id) ?? []) {
			if (!ids.has(childId)) {
				ids.add(childId);
				queue.push({ depth: depth + 1, id: childId });
			}
		}
	}

	return { distances, ids };
}

/**
 * The hovered node and everything below it when the tree is rooted at the
 * graph centre. Roots the tree on every call; renderers build it once with
 * buildRootedTree and call descendantsOf instead.
 */
export function downstreamOf(
	hoveredId: string,
	nodes: ReadonlyArray<IdNode>,
	edges: ReadonlyArray<Edge>,
): { ids: Set<string>; distances: Map<string, number> } {
	return descendantsOf(hoveredId, buildRootedTree(nodes, edges));
}

/**
 * Orders ids from most to least central: eccentricity ascending, then tree
 * degree descending, then the order they were given in. Ids that are not in
 * `nodes` sort last. For ordering lists; the renderers do not use it.
 */
export function centralityOrder(
	ids: ReadonlyArray<string>,
	nodes: ReadonlyArray<IdNode>,
	edges: ReadonlyArray<Edge>,
): string[] {
	const eccentricityById = eccentricities(nodes, edges);
	const adjacency = adjacencyOf(nodes, edges);

	return ids
		.map((id, index) => ({
			degree: adjacency.get(id)?.size ?? 0,
			eccentricity: eccentricityById.get(id) ?? Number.POSITIVE_INFINITY,
			id,
			index,
		}))
		.sort((a, b) => {
			if (a.eccentricity !== b.eccentricity) {
				return a.eccentricity < b.eccentricity ? -1 : 1;
			}
			if (a.degree !== b.degree) return b.degree - a.degree;
			return a.index - b.index;
		})
		.map((entry) => entry.id);
}
