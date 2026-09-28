/**
 * Rendering budgets. The server owns the defaults and ceilings and sends them
 * in the Map payload; this module validates a host's custom values against
 * them. Components read limits from here, never from literals.
 */

export type MapBudgets = { nodeLimit: number; edgeLimit: number };

export type MapBudgetBounds = {
	defaults: MapBudgets;
	ceilings?: { nodeLimit?: number; edgeLimit?: number };
};

/** A host's saved budgets; null follows the deployment default. */
export type CustomBudgets = {
	nodeLimit: number | null;
	edgeLimit: number | null;
};

export type BudgetAdjustment = {
	field: keyof MapBudgets;
	/**
	 * invalid: not a positive integer. ceiling: above the deployment ceiling.
	 * treeFit: raised so every tree edge of the admitted nodes fits.
	 */
	reason: "invalid" | "ceiling" | "treeFit";
	requested: unknown;
	applied: number;
};

export type BudgetResolution = {
	budgets: MapBudgets;
	adjustments: BudgetAdjustment[];
};

/**
 * Only for a legacy result, which carries no budgets. Mirrors the server's
 * `dembrane/analysis/budgets.py` defaults.
 */
export const LEGACY_BUDGET_BOUNDS: MapBudgetBounds = {
	defaults: { edgeLimit: 450, nodeLimit: 150 },
};

export const isPositiveInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value) && value > 0;

/** The fewest visible edges that keep the tree over `nodeLimit` nodes whole. */
export const minEdgeLimit = (nodeLimit: number): number =>
	Math.max(1, nodeLimit - 1);

const sanitiseBounds = (bounds: MapBudgetBounds): MapBudgetBounds => {
	const defaults = {
		edgeLimit: isPositiveInteger(bounds.defaults?.edgeLimit)
			? bounds.defaults.edgeLimit
			: LEGACY_BUDGET_BOUNDS.defaults.edgeLimit,
		nodeLimit: isPositiveInteger(bounds.defaults?.nodeLimit)
			? bounds.defaults.nodeLimit
			: LEGACY_BUDGET_BOUNDS.defaults.nodeLimit,
	};
	const ceilings: MapBudgetBounds["ceilings"] = {};
	if (isPositiveInteger(bounds.ceilings?.nodeLimit)) {
		ceilings.nodeLimit = bounds.ceilings.nodeLimit;
	}
	if (isPositiveInteger(bounds.ceilings?.edgeLimit)) {
		ceilings.edgeLimit = bounds.ceilings.edgeLimit;
	}
	return { ceilings, defaults };
};

/**
 * The budgets the page applies: custom values where valid, defaults
 * otherwise, capped at the ceilings, with the edge budget raised to fit the
 * tree. Each change to a requested value is reported.
 */
export function resolveBudgets(
	custom: CustomBudgets,
	bounds: MapBudgetBounds,
): BudgetResolution {
	const { defaults, ceilings = {} } = sanitiseBounds(bounds);
	const adjustments: BudgetAdjustment[] = [];

	const pick = (field: keyof MapBudgets): number => {
		const requested = custom[field];
		let value = defaults[field];
		if (requested !== null && requested !== undefined) {
			if (isPositiveInteger(requested)) {
				value = requested;
			} else {
				adjustments.push({
					applied: value,
					field,
					reason: "invalid",
					requested,
				});
			}
		}
		const ceiling = ceilings[field];
		if (ceiling !== undefined && value > ceiling) {
			adjustments.push({
				applied: ceiling,
				field,
				reason: "ceiling",
				requested: value,
			});
			value = ceiling;
		}
		return value;
	};

	let nodeLimit = pick("nodeLimit");
	let edgeLimit = pick("edgeLimit");

	if (edgeLimit < minEdgeLimit(nodeLimit)) {
		const edgeCeiling = ceilings.edgeLimit;
		if (edgeCeiling !== undefined && minEdgeLimit(nodeLimit) > edgeCeiling) {
			// The tree cannot fit under the edge ceiling: admit fewer nodes.
			const applied = edgeCeiling + 1;
			adjustments.push({
				applied,
				field: "nodeLimit",
				reason: "ceiling",
				requested: nodeLimit,
			});
			nodeLimit = applied;
		}
		const applied = minEdgeLimit(nodeLimit);
		if (edgeLimit < applied) {
			adjustments.push({
				applied,
				field: "edgeLimit",
				reason: "treeFit",
				requested: edgeLimit,
			});
			edgeLimit = applied;
		}
	}

	return { adjustments, budgets: { edgeLimit, nodeLimit } };
}

export type BudgetState = "empty" | "map" | "overBudget";

/** Which entry state a scope of `count` arguments gets under `nodeLimit`. */
export function budgetState(count: number, nodeLimit: number): BudgetState {
	if (count <= 0) return "empty";
	if (count > nodeLimit) return "overBudget";
	return "map";
}

/** Highest node count that both deployment ceilings can admit. */
export function maximumAdmittedNodes(bounds: MapBudgetBounds): number | null {
	const { ceilings = {} } = sanitiseBounds(bounds);
	const limits = [
		ceilings.nodeLimit,
		ceilings.edgeLimit === undefined ? undefined : ceilings.edgeLimit + 1,
	].filter((value): value is number => value !== undefined);
	return limits.length > 0 ? Math.min(...limits) : null;
}

/**
 * Custom budgets that admit `count` nodes, or null when a ceiling forbids it.
 * The edge budget grows only as far as the tree needs.
 */
export function budgetsToAdmit(
	count: number,
	current: MapBudgets,
	bounds: MapBudgetBounds,
): MapBudgets | null {
	const { ceilings = {} } = sanitiseBounds(bounds);
	const edgeLimit = Math.max(current.edgeLimit, minEdgeLimit(count));
	if (ceilings.nodeLimit !== undefined && count > ceilings.nodeLimit) {
		return null;
	}
	if (ceilings.edgeLimit !== undefined && edgeLimit > ceilings.edgeLimit) {
		return null;
	}
	return { edgeLimit, nodeLimit: Math.max(current.nodeLimit, count) };
}

/** Query parameters for custom budgets; defaults are left to the server. */
export const budgetRequestParams = (
	custom: CustomBudgets,
): { node_limit?: number; edge_limit?: number } => ({
	...(isPositiveInteger(custom.nodeLimit)
		? { node_limit: custom.nodeLimit }
		: {}),
	...(isPositiveInteger(custom.edgeLimit)
		? { edge_limit: custom.edgeLimit }
		: {}),
});
