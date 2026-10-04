import type { MapGraphNode } from "../types";

/** A project tag as the conversations list carries it. */
type TagRow = {
	project_tag_id?: { id?: string; text?: string | null } | string;
};

export type MapTag = { id: string; name: string; slot: number };

export type TagIndex = {
	/** The tags on this map's conversations, alphabetical; slot is the colour. */
	tags: MapTag[];
	/** Tag ids per conversation id. */
	byConversation: ReadonlyMap<string, ReadonlySet<string>>;
};

export const EMPTY_TAG_INDEX: TagIndex = {
	byConversation: new Map(),
	tags: [],
};

/**
 * Which tags the map's conversations carry. Only tags on a conversation the
 * map draws from count, so the filter and the colours never offer a tag that
 * changes nothing.
 */
export function buildTagIndex(
	conversations: ReadonlyArray<{ id: string; tags?: unknown }> | undefined,
	onMap: ReadonlySet<string>,
): TagIndex {
	if (!conversations?.length) return EMPTY_TAG_INDEX;
	const names = new Map<string, string>();
	const byConversation = new Map<string, Set<string>>();
	for (const conversation of conversations) {
		if (!onMap.has(conversation.id) || !Array.isArray(conversation.tags)) {
			continue;
		}
		for (const row of conversation.tags as TagRow[]) {
			const tag = row?.project_tag_id;
			if (!tag || typeof tag !== "object" || !tag.id) continue;
			names.set(tag.id, tag.text?.trim() || tag.id);
			const ids = byConversation.get(conversation.id) ?? new Set<string>();
			ids.add(tag.id);
			byConversation.set(conversation.id, ids);
		}
	}
	if (names.size === 0) return EMPTY_TAG_INDEX;
	const tags = [...names.entries()]
		.sort((a, b) => a[1].localeCompare(b[1]))
		.map(([id, name], slot) => ({ id, name, slot }));
	return { byConversation, tags };
}

/** Nodes with the tag slots of their conversations, for colouring by tag. */
export function withTagSlots(
	nodes: MapGraphNode[],
	index: TagIndex,
): MapGraphNode[] {
	if (index.tags.length === 0) return nodes;
	const slotOf = new Map(index.tags.map((tag) => [tag.id, tag.slot] as const));
	return nodes.map((node) => {
		const slots = new Set<number>();
		for (const id of node.metadata.conversationIds) {
			for (const tagId of index.byConversation.get(id) ?? []) {
				const slot = slotOf.get(tagId);
				if (slot !== undefined) slots.add(slot);
			}
		}
		return {
			...node,
			metadata: {
				...node.metadata,
				tagSlots: [...slots].sort((a, b) => a - b),
			},
		};
	});
}

/** Conversations on the map that carry none of the chosen tags. */
export function conversationsWithoutTags(
	onMap: Iterable<string>,
	chosen: ReadonlySet<string>,
	index: TagIndex,
): string[] {
	if (chosen.size === 0) return [];
	const without: string[] = [];
	for (const id of onMap) {
		const tags = index.byConversation.get(id);
		if (!tags || ![...tags].some((tag) => chosen.has(tag))) without.push(id);
	}
	return without;
}
