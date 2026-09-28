/**
 * Rendering budgets: how many nodes and visible edges a view may draw. A deployment may
 * set ceilings; a host value above one is refused with the reason, never clamped. Budgets
 * affect display only, never extraction, stored objects or revisions.
 * `edgeLimit >= nodeLimit - 1` always holds, so the admitted tree fits whole.
 */

export const DEFAULT_NODE_LIMIT = 150;
export const DEFAULT_EDGE_LIMIT = 450;

export class BudgetError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

export interface Budgets {
  readonly nodeLimit: number;
  readonly edgeLimit: number;
}

export interface Ceilings {
  readonly nodeLimit: number | null;
  readonly edgeLimit: number | null;
}

export interface ResolvedBudgets {
  readonly budgets: Budgets;
  readonly defaults: Budgets;
  readonly ceilings: Ceilings;
  readonly adjustments: readonly string[];
}

export function budgetsPayload(r: ResolvedBudgets): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    nodeLimit: r.budgets.nodeLimit,
    edgeLimit: r.budgets.edgeLimit,
    defaults: { nodeLimit: r.defaults.nodeLimit, edgeLimit: r.defaults.edgeLimit },
  };
  if (r.ceilings.nodeLimit !== null || r.ceilings.edgeLimit !== null)
    payload.ceilings = {
      ...(r.ceilings.nodeLimit !== null && { nodeLimit: r.ceilings.nodeLimit }),
      ...(r.ceilings.edgeLimit !== null && { edgeLimit: r.ceilings.edgeLimit }),
    };
  if (r.adjustments.length) payload.adjustments = [...r.adjustments];
  return payload;
}

function positiveInt(field: string, value: number): number {
  if (!Number.isInteger(value))
    throw new BudgetError(field, `${field} must be a positive whole number, got ${value}`);
  if (value < 1)
    throw new BudgetError(field, `${field} must be a positive whole number, got ${value}`);
  return value;
}

export function defaultBudgets(ceilings: Ceilings): Budgets {
  let node = DEFAULT_NODE_LIMIT;
  let edge = DEFAULT_EDGE_LIMIT;
  if (ceilings.nodeLimit !== null) node = Math.min(node, ceilings.nodeLimit);
  if (ceilings.edgeLimit !== null) {
    edge = Math.min(edge, ceilings.edgeLimit);
    node = Math.min(node, edge + 1);
  }
  return { nodeLimit: node, edgeLimit: Math.max(edge, node - 1) };
}

export function validateBudgets(nodeLimit: number, edgeLimit: number, ceilings: Ceilings): Budgets {
  const node = positiveInt("nodeLimit", nodeLimit);
  const edge = positiveInt("edgeLimit", edgeLimit);
  if (ceilings.nodeLimit !== null && node > ceilings.nodeLimit)
    throw new BudgetError(
      "nodeLimit",
      `nodeLimit ${node} is above this deployment's ceiling of ${ceilings.nodeLimit} nodes`,
    );
  if (ceilings.edgeLimit !== null && edge > ceilings.edgeLimit)
    throw new BudgetError(
      "edgeLimit",
      `edgeLimit ${edge} is above this deployment's ceiling of ${ceilings.edgeLimit} edges`,
    );
  if (edge < node - 1)
    throw new BudgetError(
      "edgeLimit",
      `edgeLimit must be at least nodeLimit - 1 (${node - 1}) so every tree edge fits, got ${edge}`,
    );
  return { nodeLimit: node, edgeLimit: edge };
}

/** Saved settings (either may be missing) resolved into budgets. */
export function resolveBudgets(
  nodeLimit: number | null,
  edgeLimit: number | null,
  ceilings: Ceilings,
): ResolvedBudgets {
  const defaults = defaultBudgets(ceilings);
  const adjustments: string[] = [];
  const node = nodeLimit === null ? defaults.nodeLimit : positiveInt("nodeLimit", nodeLimit);
  let edge: number;
  if (edgeLimit === null) {
    edge = defaults.edgeLimit;
    if (edge < node - 1) {
      edge = node - 1;
      adjustments.push(
        `edgeLimit raised to ${edge} so all ${node - 1} tree edges of ${node} nodes fit`,
      );
    }
  } else edge = positiveInt("edgeLimit", edgeLimit);
  return { budgets: validateBudgets(node, edge, ceilings), defaults, ceilings, adjustments };
}
