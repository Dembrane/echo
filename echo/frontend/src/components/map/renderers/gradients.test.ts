import { describe, expect, it } from "vitest";
import { blendStops, gradientId } from "./gradients";

describe("blending a node from several colours", () => {
	it("gives each colour a band as wide as its share of the members", () => {
		// Two members from the first conversation, one from the second.
		expect(blendStops(["#00FFFF", "#00FFFF", "#1EFFA1"])).toEqual([
			{ color: "#00FFFF", offset: 0 },
			{ color: "#00FFFF", offset: 1 / 3 },
			{ color: "#1EFFA1", offset: 5 / 6 },
			{ color: "#1EFFA1", offset: 1 },
		]);
	});

	it("is the same blend for the same members, whatever else changed", () => {
		expect(blendStops(["#A", "#B"])).toEqual(blendStops(["#A", "#B"]));
		expect(blendStops(["#A", "#B"])).not.toEqual(blendStops(["#B", "#A"]));
	});

	it("draws one colour flat and nothing at all from nothing", () => {
		expect(blendStops(["#A"])).toEqual([
			{ color: "#A", offset: 0 },
			{ color: "#A", offset: 1 },
		]);
		expect(blendStops([])).toEqual([]);
	});

	it("keeps a revision id usable in a url reference", () => {
		expect(gradientId("«r1»", "9f1e:2/3")).toBe("_r1_-9f1e_2_3");
	});
});
