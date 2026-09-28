import { OBJECT_TYPES } from "../attributes";
import type { MapGraphNode, ObjectType } from "../types";

export const zeroTypeCounts = (): Record<ObjectType, number> =>
	Object.fromEntries(OBJECT_TYPES.map((type) => [type, 0])) as Record<
		ObjectType,
		number
	>;

export function countNodesByType(
	nodes: ReadonlyArray<MapGraphNode>,
): Record<ObjectType, number> {
	const counts = zeroTypeCounts();
	for (const node of nodes) counts[node.metadata.objectType] += 1;
	return counts;
}

/** A stable key for a type selection, for memos and query keys. */
export const typesKey = (types: ReadonlyArray<ObjectType>): string =>
	[...types].sort().join(",");

/**
 * The nodes of the selected types. Returns the input array when every node
 * passes, so geometry keyed on array identity does not restart.
 */
export function filterNodesByType(
	nodes: MapGraphNode[],
	types: ReadonlySet<ObjectType>,
): MapGraphNode[] {
	const kept = nodes.filter((node) => types.has(node.metadata.objectType));
	return kept.length === nodes.length ? nodes : kept;
}

export const countForTypes = (
	counts: Record<ObjectType, number>,
	types: ReadonlyArray<ObjectType>,
): number => types.reduce((total, type) => total + (counts[type] ?? 0), 0);

/**
 * Types selected when nothing asks for others: the available types that fit
 * the node budget together, in filter order. Deduplicated arguments stand in
 * for the raw arguments they consolidate. When none fits, every available type
 * is selected, so the over-budget state can explain the choice.
 */
export function defaultVisibleTypes(
	counts: Record<ObjectType, number>,
	nodeLimit: number,
): ObjectType[] {
	const available = OBJECT_TYPES.filter((type) => (counts[type] ?? 0) > 0);
	const candidates = available.includes("deduplicated_argument")
		? available.filter((type) => type !== "argument")
		: available;
	const selected: ObjectType[] = [];
	let total = 0;
	for (const type of candidates) {
		if (total + counts[type] > nodeLimit) continue;
		selected.push(type);
		total += counts[type];
	}
	return selected.length > 0 ? selected : candidates;
}

/** The URL or saved selection, else the server's, else the default. */
export function resolveVisibleTypes({
	requested,
	serverTypes,
	counts,
	nodeLimit,
}: {
	requested: ReadonlyArray<ObjectType> | null;
	serverTypes: ReadonlyArray<ObjectType> | null;
	counts: Record<ObjectType, number>;
	nodeLimit: number;
}): ObjectType[] {
	if (requested) return OBJECT_TYPES.filter((type) => requested.includes(type));
	if (serverTypes) {
		return OBJECT_TYPES.filter((type) => serverTypes.includes(type));
	}
	return defaultVisibleTypes(counts, nodeLimit);
}

/** Arguments are most of the visible scope: deduplication would help. */
export const argumentsDominate = (
	counts: Record<ObjectType, number>,
	types: ReadonlyArray<ObjectType>,
): boolean => {
	if (!types.includes("argument")) return false;
	const total = countForTypes(counts, types);
	return total > 0 && counts.argument * 2 > total;
};
