import { describe, expect, it } from "vitest";
import { densityToDial, dialToDensity } from "../panels/MapToolbar";
import {
	clusterForceParams,
	LOCAL_MAP_FORCE_DEFAULTS,
	MST_FORCE_DEFAULTS,
	treeForceParams,
} from "./forces";

describe("the cluster density dial", () => {
	it("leaves the forces alone at 1", () => {
		expect(clusterForceParams(LOCAL_MAP_FORCE_DEFAULTS, 1)).toBe(
			LOCAL_MAP_FORCE_DEFAULTS,
		);
		expect(treeForceParams(MST_FORCE_DEFAULTS, 1)).toBe(MST_FORCE_DEFAULTS);
	});

	it("spreads both maps above 1 and clumps them below, the tree more gently", () => {
		const cluster = clusterForceParams(LOCAL_MAP_FORCE_DEFAULTS, 4);
		expect(cluster.chargeStrength).toBe(
			LOCAL_MAP_FORCE_DEFAULTS.chargeStrength * 4,
		);
		const spread = treeForceParams(MST_FORCE_DEFAULTS, 4);
		const clumped = treeForceParams(MST_FORCE_DEFAULTS, 0.25);
		const ratio = spread.chargeStrength / MST_FORCE_DEFAULTS.chargeStrength;
		expect(ratio).toBeGreaterThan(1);
		expect(ratio).toBeLessThan(4);
		expect(spread.link.constant).toBeGreaterThan(
			MST_FORCE_DEFAULTS.link.constant,
		);
		expect(clumped.link.constant).toBeLessThan(
			MST_FORCE_DEFAULTS.link.constant,
		);
	});

	it("puts the default in the middle and reaches both ends", () => {
		expect(densityToDial(1)).toBe(50);
		expect(dialToDensity(50)).toBe(1);
		expect(dialToDensity(0)).toBeCloseTo(0.25);
		expect(dialToDensity(100)).toBeCloseTo(16);
		expect(densityToDial(dialToDensity(80))).toBe(80);
	});
});
