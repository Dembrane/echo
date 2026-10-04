import { describe, expect, it } from "vitest";
import type { Edge, MapRelation } from "../types";
import { neighbourhood } from "./LocalGraph";

const edge = (source: string, target: string): Edge => ({
	distance: 0.5,
	source,
	target,
});
const edges = [edge("a", "b"), edge("b", "c"), edge("c", "d")];
const relations: MapRelation[] = [
	{ basis: "inferred", id: "r1", source: "a", target: "z", type: "supports" },
];

describe("the local graph's neighbourhood", () => {
	it("draws an argument with its tree neighbours and its relationships", () => {
		const { ids, links } = neighbourhood(["b"], edges, relations, true);
		expect(new Set(ids)).toEqual(new Set(["a", "b", "c", "z"]));
		expect(links.filter((link) => link.relation)).toHaveLength(1);
		expect(links.filter((link) => !link.relation)).toHaveLength(2);
	});

	it("draws a cluster as its own nodes and the edges between them", () => {
		const { ids, links } = neighbourhood(["a", "b", "d"], edges, [], false);
		expect(new Set(ids)).toEqual(new Set(["a", "b", "d"]));
		expect(links).toEqual([{ relation: false, source: "a", target: "b" }]);
	});
});
