import type { Edge } from "../types";
import { findGraphCenter } from "./mst";

/**
 * Radial initial layout rooted at the graph centre (minimum eccentricity).
 * BFS builds a tree from the root, and each child receives an angular slice
 * proportional to its subtree size.
 */
export function calculateInitialPositions(
	nodes: ReadonlyArray<{ id: string }>,
	edges: ReadonlyArray<Edge>,
	width: number,
	height: number,
): Map<string, { x: number; y: number }> {
	const positions = new Map<string, { x: number; y: number }>();
	const centerX = width / 2;
	const centerY = height / 2;

	if (nodes.length === 0) return positions;

	if (nodes.length === 1) {
		positions.set(nodes[0].id, { x: centerX, y: centerY });
		return positions;
	}

	const adjacency = new Map<string, Set<string>>();
	for (const node of nodes) {
		adjacency.set(node.id, new Set());
	}
	for (const edge of edges) {
		adjacency.get(edge.source)?.add(edge.target);
		adjacency.get(edge.target)?.add(edge.source);
	}

	const rootId = findGraphCenter(nodes, edges) as string;

	const visited = new Set<string>();
	const parent = new Map<string, string | null>();
	const children = new Map<string, string[]>();
	const subtreeSizes = new Map<string, number>();
	const nodesByDepth = new Map<number, string[]>();

	// First pass: tree structure
	const queue: { id: string; depth: number }[] = [{ depth: 0, id: rootId }];
	parent.set(rootId, null);

	while (queue.length > 0) {
		const { id, depth } = queue.shift() as { id: string; depth: number };
		if (visited.has(id)) continue;

		visited.add(id);
		if (!nodesByDepth.has(depth)) {
			nodesByDepth.set(depth, []);
		}
		nodesByDepth.get(depth)?.push(id);

		const neighbors = adjacency.get(id) || new Set<string>();
		const nodeChildren: string[] = [];
		for (const neighborId of neighbors) {
			if (!visited.has(neighborId)) {
				parent.set(neighborId, id);
				nodeChildren.push(neighborId);
				queue.push({ depth: depth + 1, id: neighborId });
			}
		}
		children.set(id, nodeChildren);
	}

	// Second pass: subtree sizes, bottom-up
	const maxDepth = Math.max(...nodesByDepth.keys());
	for (let depth = maxDepth; depth >= 0; depth--) {
		const nodesAtDepth = nodesByDepth.get(depth) || [];
		for (const nodeId of nodesAtDepth) {
			const nodeChildren = children.get(nodeId) || [];
			const childrenSize = nodeChildren.reduce(
				(sum, childId) => sum + (subtreeSizes.get(childId) || 0),
				0,
			);
			subtreeSizes.set(nodeId, 1 + childrenSize);
		}
	}

	const radiusStep = (Math.min(width, height) / (2 * (maxDepth + 2))) * 3;

	function assignAnglesRecursively(
		nodeId: string,
		depth: number,
		startAngle: number,
		endAngle: number,
	) {
		const radius = depth * radiusStep;
		const centerAngle = (startAngle + endAngle) / 2;

		positions.set(nodeId, {
			x: centerX + Math.cos(centerAngle) * radius,
			y: centerY + Math.sin(centerAngle) * radius,
		});

		const nodeChildren = children.get(nodeId) || [];
		if (nodeChildren.length === 0) return;

		const totalSubtreeSize = nodeChildren.reduce(
			(sum, childId) => sum + (subtreeSizes.get(childId) || 1),
			0,
		);
		const angleRange = endAngle - startAngle;

		let currentAngle = startAngle;
		for (const childId of nodeChildren) {
			const childSubtreeSize = subtreeSizes.get(childId) || 1;
			const childAngleRange =
				(childSubtreeSize / totalSubtreeSize) * angleRange;
			const childStartAngle = currentAngle;
			const childEndAngle = currentAngle + childAngleRange;

			assignAnglesRecursively(
				childId,
				depth + 1,
				childStartAngle,
				childEndAngle,
			);
			currentAngle = childEndAngle;
		}
	}

	assignAnglesRecursively(rootId, 0, 0, 2 * Math.PI);

	return positions;
}

/**
 * Scale and centre that fit the points (plus padding on every side) into a
 * width x height viewport. The scale never exceeds 1: it only zooms out.
 * Null when no point has a finite position.
 */
export function fitToViewport(
	points: Iterable<{ x?: number; y?: number }>,
	width: number,
	height: number,
	padding: number,
): { scale: number; centerX: number; centerY: number } | null {
	let minX = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	let count = 0;

	for (const { x, y } of points) {
		if (typeof x !== "number" || typeof y !== "number") continue;
		if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
		minX = Math.min(minX, x);
		maxX = Math.max(maxX, x);
		minY = Math.min(minY, y);
		maxY = Math.max(maxY, y);
		count++;
	}

	if (count === 0) return null;

	minX -= padding;
	maxX += padding;
	minY -= padding;
	maxY += padding;

	return {
		centerX: (minX + maxX) / 2,
		centerY: (minY + maxY) / 2,
		scale: Math.min(width / (maxX - minX), height / (maxY - minY), 1),
	};
}
