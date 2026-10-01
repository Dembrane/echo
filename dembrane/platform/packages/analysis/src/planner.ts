import { AnalysisValidationError, type Json } from "./contracts";
import { canonicalJson } from "./hashing";
import {
  getRecipe,
  inputName,
  type Recipe,
  validateParameters,
  validateScopeKey,
} from "./registry";

/**
 * Recipe dependency plans: which producer scopes a request needs, in order. A cycle in
 * execution dependencies is refused with its path before anything is written or any
 * model is called.
 */

export const MAX_PLAN_NODES = 64;

export class DependencyCycle extends AnalysisValidationError {
  constructor(readonly path: string[]) {
    super(`recipe dependency cycle: ${path.join(" -> ")}`);
  }
}

export class PlanConflict extends AnalysisValidationError {}

export const nodeKey = (recipeId: string, scopeKey: string) => `${recipeId}@${scopeKey}`;

export interface PlanNode {
  readonly key: string;
  readonly recipeId: string;
  readonly scopeKey: string;
  readonly parameters: Json;
  /** (input name, node key) for each direct dependency. */
  readonly dependencies: readonly (readonly [string, string])[];
}

export interface Plan {
  readonly root: string;
  /** Dependencies before their dependants; the root is last. */
  readonly nodes: readonly PlanNode[];
}

export function planNode(plan: Plan, key: string): PlanNode {
  const node = plan.nodes.find((n) => n.key === key);
  if (!node) throw new Error(`no plan node ${key}`);
  return node;
}

export const rootNode = (plan: Plan) => plan.nodes[plan.nodes.length - 1] as PlanNode;

export function buildPlan(
  recipeId: string,
  scopeKey: string,
  parameters: Json | null = null,
  lookup: (id: string) => Recipe = getRecipe,
): Plan {
  const ordered: PlanNode[] = [];
  const done = new Map<string, PlanNode>();
  const stack: string[] = [];

  const visit = (rid: string, skey: string, params: Json): string => {
    const key = nodeKey(rid, skey);
    if (stack.includes(key)) throw new DependencyCycle([...stack.slice(stack.indexOf(key)), key]);
    const recipe = lookup(rid);
    validateScopeKey(recipe, skey);
    const validated = validateParameters(recipe, params);
    const seen = done.get(key);
    if (seen) {
      if (canonicalJson(seen.parameters) !== canonicalJson(validated))
        throw new PlanConflict(`${key} is needed with two different parameter sets`);
      return key;
    }
    if (done.size >= MAX_PLAN_NODES)
      throw new PlanConflict(`the plan for ${recipeId} needs more than ${MAX_PLAN_NODES} scopes`);
    stack.push(key);
    const edges: [string, string][] = [];
    const names = new Set<string>();
    for (const dep of recipe.dependencies?.(skey, validated) ?? []) {
      const name = inputName(dep);
      if (names.has(name)) throw new PlanConflict(`${key} names two dependencies '${name}'`);
      names.add(name);
      edges.push([name, visit(dep.recipeId, dep.scopeKey, dep.parameters ?? {})]);
    }
    stack.pop();
    const node: PlanNode = {
      key,
      recipeId: rid,
      scopeKey: skey,
      parameters: validated,
      dependencies: edges,
    };
    done.set(key, node);
    ordered.push(node);
    return key;
  };

  const root = visit(recipeId, scopeKey, parameters ?? {});
  return { root, nodes: ordered };
}
