import { AnalysisValidationError, type CheckOutcome, type Json, type StepKind } from "./contracts";
import type { RecipeContext } from "./executor";
import { contentHash, HASH_VERSION } from "./hashing";
import { describeErrors, type Model, validateAgainst } from "./schema";
import SCHEMAS from "./schemas.json" with { type: "json" };
import { getObjectType, typeMetadata } from "./types";

/**
 * The recipe registry: code-owned recipe definitions, looked up by id. A recipe declares
 * what analysis happens and in which order, what it accepts and produces, how its output
 * is checked and how its objects keep their identity; the executor runs every recipe the
 * same way. Definitions are captured with every run and feed its fingerprints, so they
 * must stay exactly what the Python registry declared for the same version.
 */

export const RECIPE_ID = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
/** Declared step keys; a run's step rows add `:<instance>` for repeated steps. */
export const STEP_KEY = /^[a-z][a-z0-9_-]*$/;
export const STEP_INSTANCE = /^[A-Za-z0-9_.:@-]{1,96}$/;
/** `project`, `conversation:<uuid>`, `report:<id>`; recipes narrow it further. */
export const DEFAULT_SCOPE_KEY = /^(project|conversation:[0-9a-f-]{36}|report:[A-Za-z0-9_-]+)$/;

export class UnknownRecipe extends AnalysisValidationError {}
export class InvalidRecipeRequest extends AnalysisValidationError {}

export interface StepDef {
  readonly key: string;
  readonly version: string;
  readonly kind: StepKind;
  readonly description: string;
  readonly promptRef?: string | null;
  readonly promptVersion?: string | null;
  readonly checkVersion?: string | null;
}

export function stepDefinition(step: StepDef): Json {
  return {
    key: step.key,
    version: step.version,
    kind: step.kind,
    description: step.description,
    promptRef: step.promptRef ?? null,
    promptVersion: step.promptVersion ?? null,
    checkVersion: step.checkVersion ?? null,
  };
}

/** Another recipe's ready output this recipe consumes, by scope; `name` is how it finds it. */
export interface Dependency {
  readonly recipeId: string;
  readonly scopeKey: string;
  readonly parameters?: Json;
  readonly name?: string | null;
}

export const inputName = (d: Dependency) => d.name || d.recipeId;

export interface IdentityPolicy {
  readonly kind?: string;
  readonly description?: string;
}

const DEFAULT_IDENTITY = {
  kind: "lineage-key",
  description:
    "Identity follows the producer's lineage key; content similarity never merges identities.",
};

/** What a ready output is, whichever run recorded it: exact revisions and relation content. */
export function outputFingerprint(manifest: Json): string {
  const objects = (manifest.objects as Json[] | undefined) ?? [];
  const relations = (manifest.relations as Json[] | undefined) ?? [];
  return contentHash({
    objects: objects.map((o) => String(o.revisionId)).sort(),
    relations: relations
      .map((r) => [
        String(r.type),
        String(r.from),
        String(r.to),
        String(r.contentHash || r.relationId),
      ])
      .sort(compareLists),
  });
}

/** Python's ordering of lists of strings: element by element, by code point. */
export function compareLists(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = compareStrings(a[i] as string, b[i] as string);
    if (c) return c;
  }
  return a.length - b.length;
}

/** Python's str ordering (code points), which JavaScript's default sort only matches in the BMP. */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
    if (d) return d;
  }
  return x.length - y.length;
}

export const sortedStrings = (xs: Iterable<string>) => [...xs].sort(compareStrings);

/** A dependency's exact ready output, pinned before the consumer runs. */
export class PinnedOutput {
  constructor(
    readonly name: string,
    readonly recipeId: string,
    readonly scopeKey: string,
    readonly scopeId: string,
    readonly runId: string,
    readonly manifest: Json,
    readonly withdrawn: readonly string[] = [],
  ) {}

  withName(name: string): PinnedOutput {
    return new PinnedOutput(
      name,
      this.recipeId,
      this.scopeKey,
      this.scopeId,
      this.runId,
      this.manifest,
      this.withdrawn,
    );
  }

  get manifestHash(): string {
    return String(this.manifest.contentHash || contentHash(this.manifest));
  }

  get revisionIds(): string[] {
    const withdrawn = new Set(this.withdrawn);
    return ((this.manifest.objects as Json[] | undefined) ?? [])
      .filter((o) => !withdrawn.has(String(o.objectId)))
      .map((o) => String(o.revisionId));
  }

  json(): Json {
    return {
      recipeId: this.recipeId,
      scopeKey: this.scopeKey,
      scopeId: this.scopeId,
      runId: this.runId,
      manifestHash: this.manifestHash,
      outputFingerprint: outputFingerprint(this.manifest),
      revisionIds: this.revisionIds,
      ...(this.withdrawn.length && { withdrawnObjectIds: sortedStrings(this.withdrawn) }),
    };
  }
}

/** What a recipe's input resolver sees. It reads, never writes. */
export interface InputRequest {
  readonly projectId: string;
  readonly scopeKey: string;
  readonly parameters: Json;
  readonly selectedRevisionIds: readonly string[];
  readonly dependencies: ReadonlyMap<string, PinnedOutput>;
  readonly services: RecipeServices;
}

/** The outside world recipes use, injected by the worker (fakes in tests). */
export type RecipeServices = Readonly<Record<string, unknown>>;

export interface Recipe {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly purpose: string;
  readonly inputTypes: readonly string[];
  readonly steps: readonly StepDef[];
  readonly outputTypes: readonly string[];
  readonly execute: (ctx: RecipeContext) => Promise<void>;
  readonly dependencies?: (scopeKey: string, parameters: Json) => readonly Dependency[];
  readonly resolveInputs?: (request: InputRequest) => Promise<Json>;
  readonly validate?: (ctx: RecipeContext) => Promise<CheckOutcome[]>;
  readonly validationRules?: readonly string[];
  readonly identityPolicy?: IdentityPolicy;
  /** Object types whose Map embedding projection this recipe computes. */
  readonly embeddingProjections?: readonly string[];
  readonly parameters?: Model | null;
  readonly scopeKeyPattern?: RegExp;
  /** The model deployment identity, part of every model step's cache key. */
  readonly modelConfig?: (services: RecipeServices) => Json;
  /** Runs of this recipe running at once across workers; null is unbounded. */
  readonly maxRunning?: number | null;
  readonly modelConcurrency?: number;
  /** Input manifest keys whose parts a step names in its own `inputs`. */
  readonly partitionedInputs?: readonly string[];
}

export function recipeStep(recipe: Recipe, key: string): StepDef {
  const step = recipe.steps.find((s) => s.key === key);
  if (!step) throw new InvalidRecipeRequest(`recipe ${recipe.id} has no step '${key}'`);
  return step;
}

/** The immutable definition captured with every run. */
export function recipeDefinition(recipe: Recipe): Json {
  return {
    id: recipe.id,
    version: recipe.version,
    hashVersion: HASH_VERSION,
    inputTypes: [...recipe.inputTypes],
    outputTypes: [...recipe.outputTypes],
    steps: recipe.steps.map(stepDefinition),
    validationRules: [...(recipe.validationRules ?? [])],
    identityPolicy: {
      kind: recipe.identityPolicy?.kind ?? DEFAULT_IDENTITY.kind,
      description: recipe.identityPolicy?.description ?? DEFAULT_IDENTITY.description,
    },
    embeddingProjections: Object.fromEntries(
      (recipe.embeddingProjections ?? []).map((t) => [
        t,
        getObjectType(t).map?.projectionVersion ?? null,
      ]),
    ),
  };
}

const parameterSchemas = SCHEMAS.parameterSchemas as Record<string, Json | null>;

/** What a Recipes tab shows: the definition plus schemas. */
export function recipeMetadata(recipe: Recipe): Json {
  return {
    ...recipeDefinition(recipe),
    name: recipe.name,
    purpose: recipe.purpose,
    parametersSchema: recipe.parameters ? (parameterSchemas[recipe.id] ?? null) : null,
    outputSchemas: Object.fromEntries(
      recipe.outputTypes.map((t) => [t, typeMetadata(getObjectType(t))]),
    ),
    scopeKeyPattern: (recipe.scopeKeyPattern ?? DEFAULT_SCOPE_KEY).source,
    maxRunning: recipe.maxRunning ?? null,
    modelConcurrency: recipe.modelConcurrency ?? 4,
  };
}

export function validateParameters(recipe: Recipe, parameters: Json | null | undefined): Json {
  const raw = { ...(parameters ?? {}) };
  if (!recipe.parameters) {
    if (Object.keys(raw).length)
      throw new InvalidRecipeRequest(`recipe ${recipe.id} takes no parameters`);
    return {};
  }
  const r = validateAgainst(recipe.parameters, raw, false);
  if (!r.ok) {
    const first = r.errors[0];
    const where = first?.loc.map(String).join(".") || "(parameters)";
    throw new InvalidRecipeRequest(`invalid parameters for ${recipe.id}: ${where}: ${first?.msg}`);
  }
  return JSON.parse(JSON.stringify(r.value));
}

export function validateScopeKey(recipe: Recipe, scopeKey: unknown): string {
  const pattern = recipe.scopeKeyPattern ?? DEFAULT_SCOPE_KEY;
  if (typeof scopeKey !== "string" || !pattern.test(scopeKey))
    throw new InvalidRecipeRequest(`recipe ${recipe.id} does not accept scope ${pyRepr(scopeKey)}`);
  return scopeKey;
}

/** Python's repr for the strings and simple values that reach error texts. */
export function pyRepr(v: unknown): string {
  if (typeof v === "string") {
    const q = v.includes("'") && !v.includes('"') ? '"' : "'";
    const body = v
      .replaceAll("\\", "\\\\")
      .replaceAll("\n", "\\n")
      .replaceAll("\r", "\\r")
      .replaceAll("\t", "\\t");
    return `${q}${q === "'" ? body.replaceAll("'", "\\'") : body}${q}`;
  }
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  return String(v);
}

const recipes = new Map<string, Recipe>();

function checkDefinition(recipe: Recipe): void {
  if (!RECIPE_ID.test(recipe.id))
    throw new Error(`recipe id '${recipe.id}' is not a lowercase dotted name`);
  if (!recipe.version) throw new Error(`recipe ${recipe.id} has no version`);
  if (!recipe.steps.length) throw new Error(`recipe ${recipe.id} declares no steps`);
  const keys = recipe.steps.map((s) => s.key);
  if (new Set(keys).size !== keys.length) throw new Error(`recipe ${recipe.id} repeats a step key`);
  for (const step of recipe.steps) {
    if (!STEP_KEY.test(step.key) || !step.version)
      throw new Error(`recipe ${recipe.id} step '${step.key}' needs a key and a version`);
    if (step.kind === "model" && !(step.promptRef && step.promptVersion))
      throw new Error(`recipe ${recipe.id} model step ${step.key} needs a prompt ref and version`);
  }
  for (const t of [...recipe.inputTypes, ...recipe.outputTypes]) getObjectType(t);
  for (const t of recipe.embeddingProjections ?? [])
    if (!getObjectType(t).map)
      throw new Error(`recipe ${recipe.id} embeds ${t}, which has no Map projection`);
}

export function registerRecipe(recipe: Recipe): Recipe {
  checkDefinition(recipe);
  recipes.set(recipe.id, recipe);
  return recipe;
}

export function unregisterRecipe(id: string): void {
  recipes.delete(id);
}

export function getRecipe(id: string): Recipe {
  const r = recipes.get(id);
  if (!r) throw new UnknownRecipe(`unknown recipe ${pyRepr(id)}`);
  return r;
}

export function listRecipes(): Recipe[] {
  return [...recipes.values()].sort((a, b) => compareStrings(a.id, b.id));
}

export function describeParametersErrors(recipe: Recipe, raw: unknown): string {
  if (!recipe.parameters) return "";
  const r = validateAgainst(recipe.parameters, raw, false);
  return r.ok ? "" : describeErrors(r.errors);
}
