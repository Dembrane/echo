import type { MapGraphNode, MapRelation, ObjectType } from "../types";
import type { MapGraphData } from "./adapter";

export const SUPPORTS_POLE_A = "supports_pole_a";
export const SUPPORTS_POLE_B = "supports_pole_b";
export const DERIVED_FROM = "derived_from";

export type RelatedObject = {
	relation: MapRelation;
	/** The other endpoint's node (revision) id. */
	otherId: string;
	direction: "outgoing" | "incoming";
	/** The other endpoint, when it is in this payload. */
	node: MapGraphNode | null;
	type: ObjectType | null;
	label: string | null;
	/** Shown under the current filters. */
	visible: boolean;
};

/**
 * Every explicit relation of one node with its other endpoint resolved,
 * visible or hidden. Relations never come from embedding distance.
 */
export function relatedObjects(
	nodeId: string,
	graph: Pick<MapGraphData, "relations" | "relatedStubs">,
	nodesById: ReadonlyMap<string, MapGraphNode>,
	visibleIds: ReadonlySet<string>,
): RelatedObject[] {
	const related: RelatedObject[] = [];
	for (const relation of graph.relations) {
		let otherId: string;
		let direction: RelatedObject["direction"];
		if (relation.source === nodeId) {
			otherId = relation.target;
			direction = "outgoing";
		} else if (relation.target === nodeId) {
			otherId = relation.source;
			direction = "incoming";
		} else {
			continue;
		}
		const node = nodesById.get(otherId) ?? null;
		const stub = node ? null : (graph.relatedStubs.get(otherId) ?? null);
		related.push({
			direction,
			label: node?.label ?? stub?.label ?? null,
			node,
			otherId,
			relation,
			type: node?.metadata.objectType ?? stub?.type ?? null,
			visible: visibleIds.has(otherId),
		});
	}
	return related;
}

/** A tension's supporting objects per pole, and its other relations. */
export function tensionSupport(related: ReadonlyArray<RelatedObject>): {
	poleA: RelatedObject[];
	poleB: RelatedObject[];
	other: RelatedObject[];
} {
	const poleA: RelatedObject[] = [];
	const poleB: RelatedObject[] = [];
	const other: RelatedObject[] = [];
	for (const item of related) {
		const incoming = item.direction === "incoming";
		if (incoming && item.relation.type === SUPPORTS_POLE_A) {
			poleA.push(item);
		} else if (incoming && item.relation.type === SUPPORTS_POLE_B) {
			poleB.push(item);
		} else {
			other.push(item);
		}
	}
	return { other, poleA, poleB };
}
