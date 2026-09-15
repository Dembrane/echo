import { describe, expect, it } from "vitest";
import {
	budgetRequestParams,
	budgetState,
	budgetsToAdmit,
	type MapBudgetBounds,
	minEdgeLimit,
	resolveBudgets,
	SMALL_RESULT_LIMIT,
} from "./budgets";

// Server-shaped bounds. Tests read the default from here, never a literal.
const bounds: MapBudgetBounds = {
	ceilings: { edgeLimit: 3000, nodeLimit: 1000 },
	defaults: { edgeLimit: 450, nodeLimit: 150 },
};
const DEFAULT_NODES = bounds.defaults.nodeLimit;
const RAISED_NODES = DEFAULT_NODES * 2;

describe("resolveBudgets", () => {
	it("follows the server defaults when nothing is customised", () => {
		expect(
			resolveBudgets({ edgeLimit: null, nodeLimit: null }, bounds),
		).toEqual({ adjustments: [], budgets: bounds.defaults });
	});

	it.each([0, -5, 2.5, Number.NaN])(
		"replaces a node budget of %s with the default and says so",
		(value) => {
			const { budgets, adjustments } = resolveBudgets(
				{ edgeLimit: null, nodeLimit: value },
				bounds,
			);
			expect(budgets.nodeLimit).toBe(DEFAULT_NODES);
			expect(adjustments).toEqual([
				expect.objectContaining({ field: "nodeLimit", reason: "invalid" }),
			]);
		},
	);

	it("caps a budget at the deployment ceiling", () => {
		const { budgets, adjustments } = resolveBudgets(
			{ edgeLimit: null, nodeLimit: 5000 },
			bounds,
		);
		expect(budgets.nodeLimit).toBe(1000);
		expect(adjustments[0]).toMatchObject({
			applied: 1000,
			field: "nodeLimit",
			reason: "ceiling",
		});
	});

	describe.each([
		["default", DEFAULT_NODES],
		["raised", RAISED_NODES],
	])("edge budget around the tree at the %s node budget", (_, nodeLimit) => {
		it("raises nodeLimit - 2 to nodeLimit - 1 visibly", () => {
			const { budgets, adjustments } = resolveBudgets(
				{ edgeLimit: nodeLimit - 2, nodeLimit },
				bounds,
			);
			expect(budgets.edgeLimit).toBe(nodeLimit - 1);
			expect(adjustments).toEqual([
				expect.objectContaining({
					applied: nodeLimit - 1,
					field: "edgeLimit",
					reason: "treeFit",
				}),
			]);
		});

		it.each([-1, 0, 1])(
			"accepts an edge budget of nodeLimit %+d as saved",
			(offset) => {
				const { budgets, adjustments } = resolveBudgets(
					{ edgeLimit: nodeLimit + offset, nodeLimit },
					bounds,
				);
				expect(budgets).toEqual({ edgeLimit: nodeLimit + offset, nodeLimit });
				expect(adjustments).toEqual([]);
			},
		);
	});

	it("admits fewer nodes when the edge ceiling cannot hold their tree", () => {
		const { budgets } = resolveBudgets(
			{ edgeLimit: null, nodeLimit: 800 },
			{ ceilings: { edgeLimit: 500 }, defaults: bounds.defaults },
		);
		expect(budgets).toEqual({ edgeLimit: 500, nodeLimit: 501 });
	});

	it("never lets the edge budget drop below one", () => {
		expect(minEdgeLimit(1)).toBe(1);
		expect(
			resolveBudgets({ edgeLimit: null, nodeLimit: 1 }, bounds).budgets,
		).toEqual({ edgeLimit: 450, nodeLimit: 1 });
	});
});

describe("budgetState", () => {
	it("is empty for zero objects and small for one", () => {
		expect(budgetState(0, DEFAULT_NODES)).toBe("empty");
		expect(budgetState(1, DEFAULT_NODES)).toBe("small");
		expect(budgetState(SMALL_RESULT_LIMIT - 1, DEFAULT_NODES)).toBe("small");
		expect(budgetState(SMALL_RESULT_LIMIT, DEFAULT_NODES)).toBe("map");
	});

	it.each([
		["default", DEFAULT_NODES],
		["raised", RAISED_NODES],
	])(
		"puts nodeLimit - 1 and nodeLimit on the map and nodeLimit + 1 over budget (%s)",
		(_, nodeLimit) => {
			expect(budgetState(nodeLimit - 1, nodeLimit)).toBe("map");
			expect(budgetState(nodeLimit, nodeLimit)).toBe("map");
			expect(budgetState(nodeLimit + 1, nodeLimit)).toBe("overBudget");
		},
	);

	it("puts a small count over budget when the budget is smaller still", () => {
		expect(budgetState(20, 10)).toBe("overBudget");
	});
});

describe("budgetsToAdmit", () => {
	it("raises the node budget to the count and the edges only as far as the tree needs", () => {
		expect(budgetsToAdmit(400, bounds.defaults, bounds)).toEqual({
			edgeLimit: 450,
			nodeLimit: 400,
		});
		expect(budgetsToAdmit(600, bounds.defaults, bounds)).toEqual({
			edgeLimit: 599,
			nodeLimit: 600,
		});
	});

	it("refuses above a ceiling", () => {
		expect(budgetsToAdmit(1001, bounds.defaults, bounds)).toBeNull();
	});
});

describe("budgetRequestParams", () => {
	it("sends only custom values", () => {
		expect(budgetRequestParams({ edgeLimit: null, nodeLimit: null })).toEqual(
			{},
		);
		expect(budgetRequestParams({ edgeLimit: 900, nodeLimit: 300 })).toEqual({
			edge_limit: 900,
			node_limit: 300,
		});
	});
});
