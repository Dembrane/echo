import { i18n } from "@lingui/core";
import { describe, expect, it } from "vitest";
import {
	attributeFor,
	attributeInputsOf,
	conversationColor,
	resolveAttribute,
} from "../attributes";
import { createSyntheticMap } from "../fixtures/syntheticMap";
import type { MapGraphNode } from "../types";
import { filterNodesByConversation } from "./scope";
import { buildTagIndex, conversationsWithoutTags, withTagSlots } from "./tags";

i18n.load("en-US", {});
i18n.activate("en-US");

const tag = (id: string, text: string) => ({ project_tag_id: { id, text } });

const conversations = [
	{ id: "c1", tags: [tag("t-zoo", "Zoo"), tag("t-age", "Age")] },
	{ id: "c2", tags: [tag("t-age", "Age")] },
	{ id: "c3", tags: [] },
	// Not on the map: its tag is never offered.
	{ id: "c9", tags: [tag("t-off", "Elsewhere")] },
];
const onMap = new Set(["c1", "c2", "c3"]);
const index = buildTagIndex(conversations, onMap);

const from = (node: MapGraphNode, conversationIds: string[]): MapGraphNode => ({
	...node,
	metadata: { ...node.metadata, conversationIds },
});
const [a, b, c] = createSyntheticMap({ count: 3 });
const nodes = [from(a, ["c1"]), from(b, ["c2"]), from(c, ["c3"])];

describe("map tags", () => {
	it("offers only the tags on the map's conversations, alphabetical", () => {
		expect(index.tags).toEqual([
			{ id: "t-age", name: "Age", slot: 0 },
			{ id: "t-zoo", name: "Zoo", slot: 1 },
		]);
	});

	it("narrows to conversations with any chosen tag", () => {
		const leftOut = new Set(
			conversationsWithoutTags(onMap, new Set(["t-zoo"]), index),
		);
		expect(leftOut).toEqual(new Set(["c2", "c3"]));
		expect(
			filterNodesByConversation(nodes, leftOut).map((node) => node.id),
		).toEqual([a.id]);
		expect(conversationsWithoutTags(onMap, new Set(), index)).toEqual([]);
	});

	it("colours a node by its conversations' tags, blended, grey without", () => {
		const [tagged, single, untagged] = withTagSlots(nodes, index).map((node) =>
			resolveAttribute(attributeFor("tag"), attributeInputsOf(node.metadata)),
		);
		expect(tagged.blend).toEqual([conversationColor(0), conversationColor(1)]);
		expect(single).toMatchObject({ blend: [], color: conversationColor(0) });
		expect(untagged.key).toBe("untagged");
	});
});
