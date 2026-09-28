import { describe, expect, it } from "vitest";
import { createSyntheticMap } from "../fixtures/syntheticMap";
import type { MapGraphNode, ObjectType } from "../types";
import {
	argumentsDominate,
	countNodesByType,
	defaultVisibleTypes,
	filterNodesByType,
	resolveVisibleTypes,
	zeroTypeCounts,
} from "./scope";

const counts = (values: Partial<Record<ObjectType, number>>) => ({
	...zeroTypeCounts(),
	...values,
});

const asType = (node: MapGraphNode, objectType: ObjectType): MapGraphNode => ({
	...node,
	metadata: { ...node.metadata, objectType },
});

describe("filterNodesByType", () => {
	const nodes = createSyntheticMap({ count: 6 }).map((node, index) =>
		asType(node, index % 2 === 0 ? "argument" : "tension"),
	);

	it("keeps the same array when every node passes, so geometry does not restart", () => {
		expect(filterNodesByType(nodes, new Set(["argument", "tension"]))).toBe(
			nodes,
		);
	});

	it("narrows to the selected types and counts per type", () => {
		const kept = filterNodesByType(nodes, new Set(["tension"]));
		expect(kept.map((node) => node.metadata.objectType)).toEqual([
			"tension",
			"tension",
			"tension",
		]);
		expect(countNodesByType(nodes)).toMatchObject({ argument: 3, tension: 3 });
	});
});

describe("defaultVisibleTypes", () => {
	it("selects every available type that fits the budget", () => {
		expect(
			defaultVisibleTypes(counts({ argument: 40, tension: 5 }), 150),
		).toEqual(["argument", "tension"]);
	});

	it("prefers deduplicated arguments over the arguments they combine", () => {
		expect(
			defaultVisibleTypes(
				counts({ argument: 60, deduplicated_argument: 24, tension: 6 }),
				150,
			),
		).toEqual(["deduplicated_argument", "tension"]);
	});

	it("skips a type that would exceed the budget", () => {
		expect(
			defaultVisibleTypes(counts({ argument: 400, tension: 6 }), 150),
		).toEqual(["tension"]);
	});

	it("keeps an oversized only type, so the over-budget state explains it", () => {
		expect(defaultVisibleTypes(counts({ argument: 400 }), 150)).toEqual([
			"argument",
		]);
	});

	it("selects nothing when nothing is saved", () => {
		expect(defaultVisibleTypes(zeroTypeCounts(), 150)).toEqual([]);
	});
});

describe("resolveVisibleTypes", () => {
	const all = counts({ argument: 10, tension: 2 });

	it("takes the URL or saved selection first, then the server's, then the default", () => {
		expect(
			resolveVisibleTypes({
				counts: all,
				nodeLimit: 150,
				requested: ["tension"],
				serverTypes: ["argument"],
			}),
		).toEqual(["tension"]);
		expect(
			resolveVisibleTypes({
				counts: all,
				nodeLimit: 150,
				requested: null,
				serverTypes: ["argument"],
			}),
		).toEqual(["argument"]);
		expect(
			resolveVisibleTypes({
				counts: all,
				nodeLimit: 150,
				requested: null,
				serverTypes: null,
			}),
		).toEqual(["argument", "tension"]);
	});

	it("keeps an empty selection empty", () => {
		expect(
			resolveVisibleTypes({
				counts: all,
				nodeLimit: 150,
				requested: [],
				serverTypes: null,
			}),
		).toEqual([]);
	});
});

describe("argumentsDominate", () => {
	it("is true when arguments are most of the visible scope", () => {
		expect(
			argumentsDominate(counts({ argument: 300, tension: 6 }), [
				"argument",
				"tension",
			]),
		).toBe(true);
		expect(
			argumentsDominate(counts({ argument: 300, tension: 6 }), ["tension"]),
		).toBe(false);
		expect(
			argumentsDominate(counts({ argument: 5, popcorn: 20 }), [
				"argument",
				"popcorn",
			]),
		).toBe(false);
	});
});
