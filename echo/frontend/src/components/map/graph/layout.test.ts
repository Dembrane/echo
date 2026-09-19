import { describe, expect, it } from "vitest";
import type { Edge } from "../types";
import { calculateInitialPositions, fitToViewport } from "./layout";

const edge = (source: string, target: string): Edge => ({
	distance: 0,
	source,
	target,
});

describe("calculateInitialPositions", () => {
	it("places the graph centre at the viewport centre", () => {
		const nodes = ["a", "b", "c", "d", "e"].map((id) => ({ id }));
		const edges = [
			edge("a", "b"),
			edge("b", "c"),
			edge("c", "d"),
			edge("d", "e"),
		];
		const positions = calculateInitialPositions(nodes, edges, 800, 600);

		expect(positions.get("c")).toEqual({ x: 400, y: 300 });
		expect(positions.size).toBe(5);
		// Depth-1 nodes sit one radius step (min(800,600) / (2 * (2 + 2)) * 3 = 225) out
		const b = positions.get("b") as { x: number; y: number };
		expect(Math.hypot(b.x - 400, b.y - 300)).toBeCloseTo(225);
	});

	it("fits points into the viewport by zooming out, never in", () => {
		expect(
			fitToViewport(
				[
					{ x: 0, y: 0 },
					{ x: 1000, y: 500 },
				],
				500,
				500,
				0,
			),
		).toEqual({ centerX: 500, centerY: 250, scale: 0.5 });
		expect(
			fitToViewport(
				[
					{ x: 0, y: 0 },
					{ x: 10, y: 10 },
				],
				800,
				600,
				24,
			)?.scale,
		).toBe(1);
		expect(
			fitToViewport([{}, { x: Number.NaN, y: 1 }], 800, 600, 4),
		).toBeNull();
	});

	it("pads each point by its own padding when given a function", () => {
		const points = [
			{ id: "a", x: 0, y: 0 },
			{ id: "b", x: 100, y: 0 },
		];
		// A constant function fits exactly like the number
		expect(fitToViewport(points, 50, 50, () => 10)).toEqual(
			fitToViewport(points, 50, 50, 10),
		);
		// A larger node on the right widens the box on that side only
		const padded = fitToViewport(points, 50, 50, (point) =>
			point.id === "b" ? 40 : 10,
		);
		expect(padded).toEqual({ centerX: 65, centerY: 0, scale: 50 / 150 });
	});

	it("roots the radial layout at a given centre without searching for it", () => {
		const nodes = ["a", "b", "c", "d", "e"].map((id) => ({ id }));
		const edges = [
			edge("a", "b"),
			edge("b", "c"),
			edge("c", "d"),
			edge("d", "e"),
		];
		expect(calculateInitialPositions(nodes, edges, 800, 600, "c")).toEqual(
			calculateInitialPositions(nodes, edges, 800, 600),
		);
		expect(
			calculateInitialPositions(nodes, edges, 800, 600, "a").get("a"),
		).toEqual({ x: 400, y: 300 });
		// An unknown centre falls back to the graph centre
		expect(
			calculateInitialPositions(nodes, edges, 800, 600, "missing").get("c"),
		).toEqual({ x: 400, y: 300 });
	});

	it("centres a single node and returns nothing for no nodes", () => {
		expect(
			calculateInitialPositions([{ id: "solo" }], [], 1000, 500).get("solo"),
		).toEqual({ x: 500, y: 250 });
		expect(calculateInitialPositions([], [], 800, 600).size).toBe(0);
	});
});
