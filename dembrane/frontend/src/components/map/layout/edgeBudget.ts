/**
 * Which connections a renderer draws inside its visible-edge budget, and the
 * counts that disclose what was left out. Pure functions: drawing fewer
 * lines never changes the geometry, the forces or the walk.
 *
 * Counting: one drawn line is one slot. A neighbour pair listed in both
 * directions is one line; every relation between the same two nodes shares
 * one line.
 */
import type { LocalMapLink } from "../graph/localMap";
import type { Edge, MapRelation } from "../types";

export type EdgeCounts = {
	/** Lines drawn, all kinds together. */
	drawn: number;
	/** Lines the current toggles ask for, before the budget. */
	available: number;
	/** Tree edges drawn (MST: always every one). */
	tree: number;
	/** Relationship lines drawn. */
	relations: number;
	/** Neighbour lines drawn. */
	neighbours: number;
};

/** One relationship line: every relation between one unordered pair of nodes. */
export type RelationLine = {
	key: string;
	source: string;
	target: string;
	/** Relation types on this pair, sorted and unique. */
	types: string[];
	relationIds: string[];
	/** Touches the selected node. */
	incident: boolean;
};

export const EMPTY_EDGE_COUNTS: EdgeCounts = {
	available: 0,
	drawn: 0,
	neighbours: 0,
	relations: 0,
	tree: 0,
};

const pairKey = (a: string, b: string) => (a < b ? `${a}~${b}` : `${b}~${a}`);

/** A budget as a count of lines: non-finite or negative budgets draw nothing optional. */
const slots = (limit: number) =>
	Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;

/**
 * Relationship lines between drawn nodes, one per pair: lines touching the
 * selected node first, then by pair key, so the order does not depend on
 * the order relations arrived in. Self relations and relations with an end
 * that is not drawn are left out (the inspector lists them).
 */
export function relationLines(
	relations: ReadonlyArray<MapRelation>,
	nodeIds: ReadonlySet<string>,
	selectedId: string | null | undefined,
): RelationLine[] {
	const byPair = new Map<string, RelationLine>();
	for (const relation of relations) {
		const { source, target } = relation;
		if (source === target) continue;
		if (!nodeIds.has(source) || !nodeIds.has(target)) continue;
		const key = pairKey(source, target);
		let line = byPair.get(key);
		if (!line) {
			const [first, second] =
				source < target ? [source, target] : [target, source];
			line = {
				incident: selectedId === source || selectedId === target,
				key,
				relationIds: [],
				source: first,
				target: second,
				types: [],
			};
			byPair.set(key, line);
		}
		line.relationIds.push(relation.id);
		if (!line.types.includes(relation.type)) line.types.push(relation.type);
	}

	const lines = Array.from(byPair.values());
	for (const line of lines) {
		line.types.sort();
		line.relationIds.sort();
	}
	return lines.sort((a, b) => {
		if (a.incident !== b.incident) return a.incident ? -1 : 1;
		return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
	});
}

/** The relationship lines the toggles ask for: all, or only the selected node's. */
const requestedRelations = (
	lines: RelationLine[],
	showRelationships: boolean,
) => (showRelationships ? lines : lines.filter((line) => line.incident));

export type MstEdgeSelection = {
	tree: ReadonlyArray<Edge>;
	relations: RelationLine[];
	counts: EdgeCounts;
};

/**
 * MST: every tree edge, always (the tree is never pruned for overlays).
 * Relationship lines use what is left of the budget: the selected node's
 * relations always, all relations when showRelationships is on.
 */
export function selectMstEdges({
	treeEdges,
	relations,
	nodeIds,
	selectedId,
	edgeLimit,
	showRelationships,
}: {
	treeEdges: ReadonlyArray<Edge>;
	relations: ReadonlyArray<MapRelation>;
	nodeIds: ReadonlySet<string>;
	selectedId: string | null | undefined;
	edgeLimit: number;
	showRelationships: boolean;
}): MstEdgeSelection {
	const requested = requestedRelations(
		relationLines(relations, nodeIds, selectedId),
		showRelationships,
	);
	const overlaySlots = Math.max(0, slots(edgeLimit) - treeEdges.length);
	const drawnRelations = requested.slice(0, overlaySlots);
	return {
		counts: {
			available: treeEdges.length + requested.length,
			drawn: treeEdges.length + drawnRelations.length,
			neighbours: 0,
			relations: drawnRelations.length,
			tree: treeEdges.length,
		},
		relations: drawnRelations,
		tree: treeEdges,
	};
}

/**
 * Neighbour pairs, one per unordered pair, in a deterministic order that
 * spreads a small budget over the map: every node's nearest neighbour
 * first, then every node's second nearest, and so on; pairs touching the
 * selected node before all others. Assumes `links` lists each source's
 * neighbours nearest first, as the k-NN computation does.
 */
export function orderNeighbourPairs(
	links: ReadonlyArray<LocalMapLink>,
	selectedId: string | null | undefined,
): LocalMapLink[] {
	const seen = new Set<string>();
	const rankBySource = new Map<string, number>();
	const entries: Array<{ link: LocalMapLink; rank: number; index: number }> =
		[];
	links.forEach((link, index) => {
		const rank = rankBySource.get(link.source) ?? 0;
		rankBySource.set(link.source, rank + 1);
		if (link.source === link.target) return;
		const key = pairKey(link.source, link.target);
		if (seen.has(key)) return;
		seen.add(key);
		entries.push({ index, link, rank });
	});
	const touchesSelected = (link: LocalMapLink) =>
		selectedId != null &&
		(link.source === selectedId || link.target === selectedId);
	return entries
		.sort((a, b) => {
			const aSelected = touchesSelected(a.link);
			if (aSelected !== touchesSelected(b.link)) return aSelected ? -1 : 1;
			if (a.rank !== b.rank) return a.rank - b.rank;
			return a.index - b.index;
		})
		.map((entry) => entry.link);
}

export type LocalMapEdgeSelection = {
	neighbours: LocalMapLink[];
	relations: RelationLine[];
	counts: EdgeCounts;
};

/**
 * LocalMap: neighbour lines stay hidden unless showNeighbourLinks. Relations
 * and neighbour lines share the budget; relationship lines come first (the
 * selected node's, then the rest), neighbour lines take what is left.
 */
export function selectLocalMapEdges({
	neighbourLinks,
	relations,
	nodeIds,
	selectedId,
	edgeLimit,
	showNeighbourLinks,
	showRelationships,
}: {
	neighbourLinks: ReadonlyArray<LocalMapLink>;
	relations: ReadonlyArray<MapRelation>;
	nodeIds: ReadonlySet<string>;
	selectedId: string | null | undefined;
	edgeLimit: number;
	showNeighbourLinks: boolean;
	showRelationships: boolean;
}): LocalMapEdgeSelection {
	const budget = slots(edgeLimit);
	const requested = requestedRelations(
		relationLines(relations, nodeIds, selectedId),
		showRelationships,
	);
	const drawnRelations = requested.slice(0, budget);
	const pairs = showNeighbourLinks
		? orderNeighbourPairs(neighbourLinks, selectedId)
		: [];
	const drawnNeighbours = pairs.slice(0, budget - drawnRelations.length);
	return {
		counts: {
			available: requested.length + pairs.length,
			drawn: drawnRelations.length + drawnNeighbours.length,
			neighbours: drawnNeighbours.length,
			relations: drawnRelations.length,
			tree: 0,
		},
		neighbours: drawnNeighbours,
		relations: drawnRelations,
	};
}

export const edgeCountsEqual = (a: EdgeCounts, b: EdgeCounts) =>
	a.drawn === b.drawn &&
	a.available === b.available &&
	a.tree === b.tree &&
	a.relations === b.relations &&
	a.neighbours === b.neighbours;
