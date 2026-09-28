import { describe, expect, it } from "vitest";
import {
	createFurtherPairForce,
	createMstRepulsionForce,
	createNearestNeighbourForce,
	fruchtermanReingoldK,
	MST_FORCE_DEFAULTS,
	mstLinkDistance,
	mstViewportForces,
} from "./forces";

const at = (id: string, x?: number, y?: number) => ({
	id,
	vx: 0,
	vy: 0,
	x,
	y,
});

describe("mstLinkDistance", () => {
	it("scales (q d² + l d + c) by k / 12", () => {
		expect(
			mstLinkDistance(0.5, { constant: 8, linear: 1, quadratic: 1 }, 120),
		).toBeCloseTo((0.25 + 0.5 + 8) * 10);
		expect(
			mstLinkDistance(0.5, { constant: 12, linear: 2, quadratic: 3 }, 24),
		).toBeCloseTo((0.75 + 1 + 12) * 2);
	});

	it("clamps the distance to [0, 1] and treats a non-finite distance as 1", () => {
		const params = MST_FORCE_DEFAULTS.link;
		expect(mstLinkDistance(-0.3, params, 12)).toBe(8);
		expect(mstLinkDistance(1.7, params, 12)).toBe(10);
		expect(mstLinkDistance(Number.NaN, params, 12)).toBe(10);
	});

	it("uses k = sqrt(width x height / n)", () => {
		const k = fruchtermanReingoldK(1024, 768, 53);
		expect(k).toBeCloseTo(Math.sqrt((1024 * 768) / 53));
		expect(mstLinkDistance(0, MST_FORCE_DEFAULTS.link, k)).toBeCloseTo(
			(8 * k) / 12,
		);
		expect(fruchtermanReingoldK(800, 600, 0)).toBeCloseTo(Math.sqrt(800 * 600));
	});
});

describe("mstViewportForces", () => {
	it("centres the graph with a 4k charge horizon and a 10x viewport MST horizon", () => {
		const k = fruchtermanReingoldK(1440, 900, 53);
		expect(mstViewportForces(1440, 900, 53)).toEqual({
			centerX: 720,
			centerY: 450,
			chargeDistanceMax: 4 * k,
			k,
			mstRepulsionMaxDistance: 14400,
		});
	});
});

describe("createNearestNeighbourForce", () => {
	it("pulls a pair together when one node sits at x = 0, y = 0", () => {
		const origin = at("a", 0, 0);
		const other = at("b", 30, 40);
		const force = createNearestNeighbourForce(
			[{ source: "a", target: "b" }],
			10,
			10,
		);
		force.initialize([origin, other]);
		force(1);

		expect(origin.vx).toBeGreaterThan(0);
		expect(origin.vy).toBeGreaterThan(0);
		expect(other.vx).toBeLessThan(0);
		expect(other.vy).toBeLessThan(0);
	});

	it("skips pairs with an unknown node or no position", () => {
		const placed = at("a", 5, 5);
		const unplaced = at("b");
		const force = createNearestNeighbourForce(
			[
				{ source: "a", target: "b" },
				{ source: "a", target: "ghost" },
			],
			10,
			10,
		);
		force.initialize([placed, unplaced]);
		force(1);

		expect(placed.vx).toBe(0);
		expect(unplaced.vx).toBe(0);
	});
});

describe("createFurtherPairForce", () => {
	it("pushes a pair apart when one node sits at y = 0", () => {
		const a = at("a", 10, 0);
		const b = at("b", 20, 5);
		const force = createFurtherPairForce([{ source: "a", target: "b" }]);
		force.initialize([a, b]);
		force(1);

		expect(a.vx).toBeLessThan(0);
		expect(b.vx).toBeGreaterThan(0);
	});
});

describe("createMstRepulsionForce", () => {
	it("repels tree-distant nodes, including one at the origin", () => {
		const origin = at("a", 0, 0);
		const other = at("b", 3, 4);
		const distances = new Map([
			["a", new Map([["b", 2]])],
			["b", new Map([["a", 2]])],
		]);
		const force = createMstRepulsionForce(distances, 0.5).setMaxDistance(100);
		force.initialize([origin, other]);
		force(1);

		expect(origin.vx).toBeLessThan(0);
		expect(other.vx).toBeGreaterThan(0);
	});

	it("ignores pairs beyond the max distance", () => {
		const a = at("a", 0, 0);
		const b = at("b", 300, 400);
		const distances = new Map([["a", new Map([["b", 2]])]]);
		const force = createMstRepulsionForce(distances, 0.5).setMaxDistance(100);
		force.initialize([a, b]);
		force(1);

		expect(a.vx).toBe(0);
	});
});
