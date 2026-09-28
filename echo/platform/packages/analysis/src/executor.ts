import type { Logger } from "@echo/observability";
import {
  AnalysisStoreError,
  AnalysisValidationError,
  type CheckOutcome,
  checkFromJson,
  checkJson,
  extraOf,
  type Json,
  type NewRun,
  type ObjectRevision,
  PublicationRejected,
  type Relation,
  type RelationBasis,
  ReuseOutdated,
  RUN_MODES,
  type Run,
  type RunMode,
  type SourceRef,
  type Step,
  type StepWrite,
  sourceRefFromJson,
} from "./contracts";
import { contentHash, fingerprint, HASH_VERSION } from "./hashing";
import { buildPlan, type PlanNode, planNode, rootNode } from "./planner";
import {
  getRecipe,
  InvalidRecipeRequest,
  PinnedOutput,
  type Recipe,
  type RecipeServices,
  recipeDefinition,
  recipeStep,
  STEP_INSTANCE,
  type StepDef,
  sortedStrings,
  UnknownRecipe,
  validateParameters,
  validateScopeKey,
} from "./registry";
import { RevisionService, type StagedRevision } from "./revisions";
import type { AnalysisStore } from "./store";
import { validatePayload } from "./types";

/**
 * The one way a recipe runs: request, plan, queue, execute, validate, publish. Requests
 * are validated and planned before anything is written; dependencies with a ready output
 * are pinned, one in flight is shared, a missing one is requested, and a run whose inputs
 * are not ready waits without holding a worker. Execution claims the run under a lease,
 * pins its inputs once, runs the recipe through a RecipeContext whose steps checkpoint
 * their actual output to analysis_step, validates, and publishes in one transaction.
 * Every checkpoint rechecks the lease, so a cancelled or overtaken run stops writing.
 */

/** Progress reaches the page at most this often; step completions always save. */
export const PROGRESS_INTERVAL_MS = 1500;
/** A worker finding its recipe at the running limit asks again this much later. */
export const BUSY_RETRY_SECONDS = 30;
/** During a long step the lease is renewed this often, far inside its deadline. */
export const KEEPALIVE_MS = 60_000;
export const MANIFEST_VERSION = 1;
/** A run publishes again this many times when hosts keep editing its objects. */
export const PUBLISH_ATTEMPTS = 3;

export const liveChannel = (projectId: string) => `analysis:project:${projectId}`;

/** The run stopped being this worker's: cancelled, superseded, expired, fenced or retried. */
export class RunStopped extends Error {}

export class ValidationFailed extends Error {
  constructor(readonly checks: CheckOutcome[]) {
    super(
      `checks failed: ${checks
        .filter((c) => c.status === "failed")
        .map((c) => c.check)
        .join(", ")}`,
    );
  }
}

/** A failure whose message was written for the page (no participant text). */
export class RecipeFailed extends Error {}

export interface ExecutorDeps {
  readonly store: AnalysisStore;
  /** A nudge on the project's analysis channel; best effort. */
  readonly publishEvent: (projectId: string, event: Json) => Promise<void>;
  /** Hands a queued run to a worker; returns its execution reference. Absent: nothing is sent. */
  readonly dispatchRun?: ((runId: string) => Promise<string | null>) | null;
  readonly services: RecipeServices;
  readonly logger?: Logger;
  readonly clock?: () => number;
  readonly keepaliveMs?: number;
}

const now = (deps: ExecutorDeps) => (deps.clock ?? Date.now)();

// ── requests ────────────────────────────────────────────────────────────

export interface RunRequest {
  readonly projectId: string;
  readonly recipeId: string;
  readonly scopeKey: string;
  readonly mode?: string;
  readonly parameters?: Json;
  readonly selectedRevisionIds?: readonly string[];
  readonly idempotencyKey?: string | null;
  readonly requestedBy?: string | null;
  /** Context and sensitivity versions: part of every cache key, never free text. */
  readonly context?: Json;
  /** Request fresh dependency runs instead of pinning their ready outputs. */
  readonly refreshDependencies?: boolean;
  /** Retry: which failed run (default: the scope's latest failed run). */
  readonly retryRunId?: string | null;
}

/** created, existing (same key or equivalent work in flight), reused, or requeued. */
export interface RequestOutcome {
  readonly run: Run;
  readonly outcome: "created" | "existing" | "reused" | "requeued";
  readonly dependencies: readonly Run[];
}

/** Context keys the executor sets itself; a caller's context never replaces them. */
export const RESERVED_CONTEXT = ["model", "selectedRevisionIds"];

/**
 * An input manifest as it bears on computation: each dependency by the output it pinned
 * (not the run that recorded it), without the partitioned keys whose parts each step
 * names in its own inputs.
 */
export function computationManifest(
  manifest: Json | null,
  partitioned: readonly string[] = [],
): Json {
  if (!manifest) return {};
  const parts = new Set(partitioned);
  const every = parts.has("dependencies");
  const out: Json = {};
  for (const [k, v] of Object.entries(manifest))
    if (!parts.has(k) && k !== "dependencies") out[k] = v;
  const deps = (manifest.dependencies as Json | undefined) ?? {};
  out.dependencies = Object.fromEntries(
    sortedStrings(Object.keys(deps)).map((name) => [
      name,
      dependencyComputation(deps[name] as Json, every || parts.has(`dependencies.${name}`)),
    ]),
  );
  return out;
}

function dependencyComputation(dependency: Json, partitioned: boolean): Json {
  const out: Json = {
    recipeId: dependency.recipeId ?? null,
    scopeKey: dependency.scopeKey ?? null,
    output: partitioned ? null : dependency.outputFingerprint || dependency.manifestHash || null,
  };
  const withdrawn = dependency.withdrawnObjectIds as unknown[] | undefined;
  if (withdrawn?.length && !partitioned) out.withdrawn = [...withdrawn];
  return out;
}

/** Equal work fingerprints compute equal outputs. */
export function workFingerprint(o: {
  recipeVersion: string;
  parameters: Json;
  context: Json;
  inputFingerprint: string | null;
  epoch: number | null;
  definitionHash: string | null;
}): string {
  return fingerprint({
    recipeVersion: o.recipeVersion,
    definition: o.definitionHash,
    parameters: o.parameters,
    context: o.context,
    inputFingerprint: o.inputFingerprint,
    epoch: o.epoch,
  });
}

function runWork(run: Run): string {
  return workFingerprint({
    recipeVersion: run.recipeVersion,
    parameters: run.parameters,
    context: run.context,
    inputFingerprint: contentHash(computationManifest(run.inputManifest)),
    epoch: run.epoch,
    definitionHash: contentHash(run.definition),
  });
}

function nodeContext(
  recipe: Recipe,
  request: RunRequest,
  services: RecipeServices,
  selected: readonly string[] = [],
): Json {
  const context: Json = {
    ...(request.context ?? {}),
    model: { ...(recipe.modelConfig?.(services) ?? {}) },
  };
  if (selected.length) context.selectedRevisionIds = [...selected];
  return context;
}

function compatible(run: Run, recipe: Recipe, parameters: Json, context: Json): boolean {
  return (
    run.recipeVersion === recipe.version &&
    contentHash(run.definition) === contentHash(recipeDefinition(recipe)) &&
    contentHash(run.parameters) === contentHash(parameters) &&
    contentHash(run.context) === contentHash(context)
  );
}

function pinned(
  name: string,
  recipeId: string,
  scopeKey: string,
  run: Run,
  withdrawn: readonly string[] = [],
) {
  return new PinnedOutput(
    name,
    recipeId,
    scopeKey,
    run.scopeId,
    run.id,
    run.outputManifest ?? {},
    sortedStrings(withdrawn),
  );
}

/** A ready output as a consumer pins it now: an object a host excluded is withdrawn. */
async function pin(
  store: AnalysisStore,
  name: string,
  recipeId: string,
  scopeKey: string,
  run: Run,
) {
  const objects = new Set(
    ((run.outputManifest?.objects as Json[] | undefined) ?? []).map((o) => String(o.objectId)),
  );
  const heads = objects.size
    ? await store.currentRevisions(run.projectId, [run.scopeId])
    : new Map();
  const withdrawn = [...heads.entries()]
    .filter(
      ([objectId, head]) => objects.has(objectId) && extraOf(head.provenance).membershipExcluded,
    )
    .map(([objectId]) => objectId);
  return pinned(name, recipeId, scopeKey, run, withdrawn);
}

async function currentReady(store: AnalysisStore, scopeId: string): Promise<Run | null> {
  const scope = await store.getScope(scopeId);
  if (!scope?.currentRunId) return null;
  const run = await store.getRun(scope.currentRunId);
  return run && run.status === "ready" && run.outputManifest ? run : null;
}

async function validateSelection(
  store: AnalysisStore,
  recipe: Recipe,
  projectId: string,
  revisionIds: readonly string[],
): Promise<string[]> {
  const ids = sortedStrings(new Set(revisionIds));
  if (!ids.length) return [];
  const found = await store.getRevisions(projectId, ids);
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length)
    throw new InvalidRecipeRequest(`${missing.length} selected revisions are not in this project`);
  for (const revision of found.values()) {
    if (revision.status !== "published")
      throw new InvalidRecipeRequest(`selected revision ${revision.id} is not published`);
    if (!recipe.inputTypes.includes(revision.type))
      throw new InvalidRecipeRequest(`recipe ${recipe.id} does not accept ${revision.type} inputs`);
  }
  return ids;
}

async function resolveInputs(
  recipe: Recipe,
  o: {
    projectId: string;
    scopeKey: string;
    parameters: Json;
    selected: readonly string[];
    dependencies: ReadonlyMap<string, PinnedOutput>;
    services: RecipeServices;
  },
): Promise<Json> {
  let resolved: Json = {};
  if (recipe.resolveInputs)
    resolved = {
      ...(await recipe.resolveInputs({
        projectId: o.projectId,
        scopeKey: o.scopeKey,
        parameters: o.parameters,
        selectedRevisionIds: o.selected,
        dependencies: o.dependencies,
        services: o.services,
      })),
    };
  const revisionIds = new Set(((resolved.revisionIds as unknown[] | undefined) ?? []).map(String));
  delete resolved.revisionIds;
  for (const id of o.selected) revisionIds.add(id);
  for (const p of o.dependencies.values()) for (const id of p.revisionIds) revisionIds.add(id);
  return {
    ...resolved,
    selectedRevisionIds: [...o.selected],
    revisionIds: sortedStrings(revisionIds),
    dependencies: Object.fromEntries(
      sortedStrings(o.dependencies.keys()).map((name) => [
        name,
        (o.dependencies.get(name) as PinnedOutput).json(),
      ]),
    ),
  };
}

/**
 * Validates, plans and queues a recipe run, or returns the run that already answers this
 * request. Validation errors (unknown recipe, invalid scope, parameters or inputs,
 * dependency cycle) are raised before anything is written.
 */
export async function requestRun(request: RunRequest, deps: ExecutorDeps): Promise<RequestOutcome> {
  const { store } = deps;
  if (request.idempotencyKey) {
    // An accepted key is answered before anything that can change after acceptance.
    const existing = await store.runByIdempotencyKey(request.projectId, request.idempotencyKey);
    if (existing) return { run: existing, outcome: "existing", dependencies: [] };
  }
  const recipe = getRecipe(request.recipeId);
  const modeRaw = request.mode ?? "refresh";
  if (!RUN_MODES.includes(modeRaw as RunMode))
    throw new InvalidRecipeRequest(`'${modeRaw}' is not a run mode`);
  const mode = modeRaw as RunMode;
  const reserved = sortedStrings(
    Object.keys(request.context ?? {}).filter((k) => RESERVED_CONTEXT.includes(k)),
  );
  if (reserved.length)
    throw new InvalidRecipeRequest(`context key '${reserved[0]}' is reserved for the executor`);
  const scopeKey = validateScopeKey(recipe, request.scopeKey);
  const parameters = validateParameters(recipe, request.parameters ?? {});
  const plan = buildPlan(recipe.id, scopeKey, parameters);
  const selected = await validateSelection(
    store,
    recipe,
    request.projectId,
    request.selectedRevisionIds ?? [],
  );

  const key = request.idempotencyKey || `auto:${crypto.randomUUID()}`;
  const scope = await store.ensureScope({
    projectId: request.projectId,
    kind: "producer",
    ownerId: recipe.id,
    scopeKey,
  });
  if (mode === "retry") return retry(deps, scope.id, request);

  const pins = new Map<string, PinnedOutput>();
  const waiting = new Map<string, Run>();
  const dependencyRuns: Run[] = [];
  for (const node of plan.nodes.slice(0, -1)) {
    const nodeRecipe = getRecipe(node.recipeId);
    const nodeScope = await store.ensureScope({
      projectId: request.projectId,
      kind: "producer",
      ownerId: node.recipeId,
      scopeKey: node.scopeKey,
    });
    const upstreamWaiting = node.dependencies.some(([, k]) => waiting.has(k));
    if (!request.refreshDependencies && !upstreamWaiting) {
      const current = await currentReady(store, nodeScope.id);
      if (
        current &&
        compatible(
          current,
          nodeRecipe,
          node.parameters,
          nodeContext(nodeRecipe, request, deps.services),
        )
      ) {
        pins.set(node.key, await pin(store, node.key, node.recipeId, node.scopeKey, current));
        continue;
      }
    }
    // Anything else is requested; equivalent work in flight is joined by the dedupe.
    const outcome = await requestNode(deps, nodeRecipe, node, {
      scopeId: nodeScope.id,
      mode: "refresh",
      key: `${key}:${node.key}`,
      selected: [],
      pins,
      waiting,
      request,
    });
    dependencyRuns.push(outcome.run);
    if (outcome.run.status === "ready")
      pins.set(node.key, await pin(store, node.key, node.recipeId, node.scopeKey, outcome.run));
    else waiting.set(node.key, outcome.run);
  }
  const root = await requestNode(deps, recipe, rootNode(plan), {
    scopeId: scope.id,
    mode,
    key,
    selected,
    pins,
    waiting,
    request,
  });
  return { ...root, dependencies: dependencyRuns };
}

async function requestNode(
  deps: ExecutorDeps,
  recipe: Recipe,
  node: PlanNode,
  o: {
    scopeId: string;
    mode: RunMode;
    key: string;
    selected: readonly string[];
    pins: ReadonlyMap<string, PinnedOutput>;
    waiting: ReadonlyMap<string, Run>;
    request: RunRequest;
  },
): Promise<RequestOutcome> {
  const { store } = deps;
  const context = nodeContext(recipe, o.request, deps.services, o.selected);
  const parameters = { ...node.parameters };
  const current = await currentReady(store, o.scopeId);
  const epoch = o.mode === "regenerate" ? null : current ? current.epoch : 0;
  const blockers = node.dependencies
    .filter(([, k]) => o.waiting.has(k))
    .map(([, k]) => o.waiting.get(k) as Run);
  // Every dependency run this run consumes, pinned or awaited.
  const dependsOn = sortedStrings(
    new Set(
      node.dependencies.map(([, k]) =>
        o.pins.has(k) ? (o.pins.get(k) as PinnedOutput).runId : (o.waiting.get(k) as Run).id,
      ),
    ),
  );
  const definition = recipeDefinition(recipe);
  const base = {
    projectId: o.request.projectId,
    scopeId: o.scopeId,
    recipeId: recipe.id,
    recipeVersion: recipe.version,
    definition,
    mode: o.mode,
    idempotencyKey: o.key,
    epoch,
    parameters,
    context,
    requestedBy: o.request.requestedBy ?? null,
    dependsOn,
  };
  let n: NewRun;
  if (blockers.length) {
    n = {
      ...base,
      requestFingerprint: fingerprint({
        waiting: true,
        recipeVersion: recipe.version,
        definition: contentHash(definition),
        parameters,
        context,
        dependsOn: [...dependsOn],
        epoch: o.mode === "refresh" ? epoch : o.key,
      }),
      status: "waiting_for_inputs",
    };
  } else {
    const dependencies = new Map(
      node.dependencies.map(([name, k]) => [name, (o.pins.get(k) as PinnedOutput).withName(name)]),
    );
    const manifest = await resolveInputs(recipe, {
      projectId: o.request.projectId,
      scopeKey: node.scopeKey,
      parameters,
      selected: o.selected,
      dependencies,
      services: deps.services,
    });
    const inputFingerprint = contentHash(manifest);
    const work = workFingerprint({
      recipeVersion: recipe.version,
      parameters,
      context,
      inputFingerprint: contentHash(computationManifest(manifest)),
      epoch,
      definitionHash: contentHash(definition),
    });
    if (o.mode === "refresh" && current && runWork(current) === work) {
      try {
        const [run, created] = await store.createRun({
          ...base,
          epoch: current.epoch,
          requestFingerprint: fingerprint({ reuse: true, key: o.key }),
          status: "ready",
          inputManifest: manifest,
          inputFingerprint,
          reusedRunId: current.id,
          outputManifest: current.outputManifest,
          metrics: { reuse: "output", reusedRunId: current.id, modelCalls: 0 },
        });
        return { run, outcome: created ? "reused" : "existing", dependencies: [] };
      } catch (err) {
        // Another run became current in between: compute instead.
        if (!(err instanceof ReuseOutdated)) throw err;
      }
    }
    n = {
      ...base,
      requestFingerprint:
        o.mode === "refresh" ? work : fingerprint({ regenerate: true, work, key: o.key }),
      status: "queued",
      inputManifest: manifest,
      inputFingerprint,
    };
  }
  let [run, created] = await store.createRun(n);
  if (!created) return { run, outcome: "existing", dependencies: [] };
  if (run.status === "waiting_for_inputs") {
    // A dependency may have finished between reading it and registering this waiter.
    const settled = await store.wakeWaitingRuns(run.projectId);
    run = [...settled.woken, ...settled.failed].find((r) => r.id === run.id) ?? run;
  }
  if (run.status === "queued") await dispatch(deps, run);
  await deps.publishEvent(run.projectId, {
    type: run.status,
    run_id: run.id,
    recipe_id: run.recipeId,
    scope_key: node.scopeKey,
  });
  return { run, outcome: "created", dependencies: [] };
}

export async function dispatch(deps: ExecutorDeps, run: Run): Promise<void> {
  if (!deps.dispatchRun) return;
  try {
    const ref = await deps.dispatchRun(run.id);
    if (ref) await deps.store.setExecutionRef(run.id, ref);
  } catch (err) {
    // The run stays queued; the minute sweep sends it again.
    deps.logger?.error(
      { run_id: run.id, err: { name: (err as Error).name } },
      "analysis run not dispatched",
    );
  }
}

async function retry(
  deps: ExecutorDeps,
  scopeId: string,
  request: RunRequest,
): Promise<RequestOutcome> {
  const { store } = deps;
  const target = request.retryRunId
    ? await store.getRun(request.retryRunId)
    : await store.latestRun(scopeId, ["failed"]);
  if (!target || target.scopeId !== scopeId || target.projectId !== request.projectId)
    throw new InvalidRecipeRequest("there is no failed run to retry in this scope");
  // The store binds the key to this run in the same transaction that requeues it.
  const bound = await store.requeueRun(target.id, request.idempotencyKey ?? null);
  if (!bound) throw new AnalysisStoreError(`run ${target.id} could not be queued again`);
  if (bound.id !== target.id || target.status !== "failed" || bound.status !== "queued")
    return { run: bound, outcome: "existing", dependencies: [] };
  await dispatch(deps, bound);
  await deps.publishEvent(bound.projectId, {
    type: "queued",
    run_id: bound.id,
    recipe_id: bound.recipeId,
  });
  return { run: bound, outcome: "requeued", dependencies: [] };
}

/** Cancels a run: its worker stops at its next checkpoint; runs waiting on it fail. */
export async function cancelRun(runId: string, deps: ExecutorDeps): Promise<Run | null> {
  const run = await deps.store.cancelRun(runId);
  if (run && run.status === "cancelled") {
    await deps.store.wakeWaitingRuns(run.projectId);
    await deps.publishEvent(run.projectId, {
      type: "cancelled",
      run_id: run.id,
      recipe_id: run.recipeId,
    });
  }
  return run;
}

// ── execution ───────────────────────────────────────────────────────────

/** What a step computed: its actual output, usage and its own check outcomes. */
export interface StepResult {
  readonly output: unknown;
  readonly usage?: Readonly<Record<string, number>>;
  readonly modelCalls?: number;
  readonly validation?: readonly CheckOutcome[];
  readonly checkpoint?: Json | null;
}

export const stepResult = (r: StepResult): StepResult & { readonly __stepResult: true } => ({
  ...r,
  __stepResult: true,
});

const isStepResult = (v: unknown): v is StepResult =>
  typeof v === "object" && v !== null && (v as { __stepResult?: boolean }).__stepResult === true;

/** Everything a step's result depends on. */
export function stepCacheKey(
  recipe: Recipe,
  step: StepDef,
  run: Run,
  inputs: unknown,
  o: { scopeKey?: string | null; instance?: string | null; upstream?: unknown } = {},
): string {
  return fingerprint({
    recipe: { id: recipe.id, version: recipe.version },
    step: {
      key: step.key,
      version: step.version,
      kind: step.kind,
      description: step.description,
      promptRef: step.promptRef ?? null,
      promptVersion: step.promptVersion ?? null,
      checkVersion: step.checkVersion ?? null,
    },
    scope: o.scopeKey ?? null,
    instance: o.instance ?? null,
    globalInputs: contentHash(
      computationManifest(run.inputManifest, recipe.partitionedInputs ?? []),
    ),
    inputs: inputs === undefined ? null : inputs,
    upstream: o.upstream === undefined ? null : o.upstream,
    parameters: run.parameters,
    context: run.context,
    epoch: step.kind === "model" ? run.epoch : null,
  });
}

class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

/** Runs tasks concurrently and waits for all; the failures surface together (Python's TaskGroup). */
export async function taskGroup(tasks: readonly (() => Promise<void>)[]): Promise<void> {
  const results = await Promise.allSettled(tasks.map((t) => t()));
  const failures = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => r.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "several tasks failed");
}

/** What a recipe's execute function works with; every write goes through the lease. */
export class RecipeContext {
  readonly revisions: RevisionService;
  readonly metrics = new Map<string, number>();
  readonly stepChecks: CheckOutcome[] = [];
  readonly objects = new Map<string, StagedRevision>();
  readonly relations = new Map<string, Relation>();
  private steps = new Map<string, Step>();
  /** Output hashes of the steps this run has produced so far, by row key. */
  private readonly outputs = new Map<string, string>();
  private readonly modelSlots: Semaphore;
  private readonly started: number;
  private lastProgress = Number.NEGATIVE_INFINITY;
  private stage = "running";

  constructor(
    readonly deps: ExecutorDeps,
    readonly recipe: Recipe,
    public run: Run,
    readonly lease: string,
    readonly scopeKey: string,
    readonly dependencies: ReadonlyMap<string, PinnedOutput>,
  ) {
    this.revisions = new RevisionService(deps.store);
    this.modelSlots = new Semaphore(recipe.modelConcurrency ?? 4);
    this.started = now(deps);
  }

  get store() {
    return this.deps.store;
  }
  get projectId() {
    return this.run.projectId;
  }
  get parameters() {
    return this.run.parameters;
  }
  get services() {
    return this.deps.services;
  }
  get inputManifest(): Json {
    return this.run.inputManifest ?? {};
  }
  get inputRevisionIds(): string[] {
    return ((this.inputManifest.revisionIds as unknown[] | undefined) ?? []).map(String);
  }

  metric(name: string): number {
    return this.metrics.get(name) ?? 0;
  }
  count(name: string, by = 1): void {
    this.metrics.set(name, this.metric(name) + by);
  }

  async loadSteps(): Promise<void> {
    this.steps = new Map((await this.store.getSteps(this.run.id)).map((s) => [s.stepKey, s]));
  }

  metricsDoc(): Json {
    return {
      ...Object.fromEntries(this.metrics),
      wallSeconds: Math.round(now(this.deps) - this.started) / 1000,
    };
  }

  /** Saves progress and tells the page; throttled unless forced; always a lease check when it saves. */
  async progress(
    stage: string | null = null,
    o: { force?: boolean; counts?: Json } = {},
  ): Promise<void> {
    if (stage) this.stage = stage;
    const t = now(this.deps);
    if (!o.force && t - this.lastProgress < PROGRESS_INTERVAL_MS) return;
    this.lastProgress = t;
    const doc = { stage: this.stage, ...(o.counts ?? {}), metrics: this.metricsDoc() };
    if (!(await this.store.heartbeatRun(this.run.id, this.lease, doc))) throw new RunStopped();
    await this.deps.publishEvent(this.projectId, {
      type: "progress",
      run_id: this.run.id,
      recipe_id: this.recipe.id,
      ...doc,
    });
  }

  /** A cancellation, supersession, fence and lease check, with no throttle. */
  checkpoint(): Promise<void> {
    return this.progress(null, { force: true });
  }

  /** Renews the lease while a long step computes; a refused renewal stops the run after it. */
  private async keptAlive<T>(fn: () => Promise<T>): Promise<T> {
    let refused = false;
    const timer = setInterval(() => {
      void this.store
        .heartbeatRun(this.run.id, this.lease, { stage: this.stage, metrics: this.metricsDoc() })
        .then((ok) => {
          if (!ok) refused = true;
        })
        .catch(() => {});
    }, this.deps.keepaliveMs ?? KEEPALIVE_MS);
    let result: T;
    try {
      result = await fn();
    } finally {
      clearInterval(timer);
    }
    if (refused) throw new RunStopped();
    return result;
  }

  private async outputOf(step: Step): Promise<unknown> {
    if (step.reusedStepId) {
      const original = await this.store.getStep(step.reusedStepId);
      if (original?.status !== "completed")
        throw new AnalysisStoreError(`reused step artifact ${step.reusedStepId} is missing`);
      return original.output;
    }
    return step.output;
  }

  /**
   * Runs one declared step (once per `instance` for repeated steps), or reuses its saved
   * artifact: this run's own completed step (a resumed run), then a completed step with
   * the same cache key anywhere in the project, then `compute`. A computed result is saved
   * with its output and check outcomes before it is returned; one whose checks failed is
   * saved as a failed attempt and stops the run.
   */
  async step<T = unknown>(
    key: string,
    compute: () => Promise<StepResult | unknown>,
    o: { instance?: string | null; inputs?: unknown; after?: readonly string[] | null } = {},
  ): Promise<T> {
    const definition = recipeStep(this.recipe, key);
    const instance = o.instance ?? null;
    if (instance !== null && !STEP_INSTANCE.test(instance))
      throw new AnalysisValidationError(`step instance '${instance}' is not a valid key`);
    const rowKey = instance !== null ? `${key}:${instance}` : key;
    let upstream: unknown = null;
    if (o.after) {
      const consumed = sortedStrings(new Set(o.after));
      const missing = consumed.filter((n) => !this.outputs.has(n));
      if (missing.length)
        throw new AnalysisValidationError(
          `step ${rowKey} consumes '${missing[0]}', which has not run`,
        );
      upstream = Object.fromEntries(consumed.map((n) => [n, this.outputs.get(n)]));
    } else if (o.inputs === undefined || o.inputs === null) {
      upstream = Object.fromEntries(
        sortedStrings(this.outputs.keys()).map((k) => [k, this.outputs.get(k)]),
      );
    }
    const cacheKey = stepCacheKey(this.recipe, definition, this.run, o.inputs ?? null, {
      scopeKey: this.scopeKey,
      instance,
      upstream,
    });
    const own = this.steps.get(rowKey);
    if (own && own.status === "completed" && own.cacheKey === cacheKey) {
      this.count("stepsResumed");
      this.stepChecks.push(...own.validation.map(checkFromJson));
      return this.remember(rowKey, await this.outputOf(own)) as T;
    }
    await this.checkpoint();
    const cached = await this.store.findReusableStep(this.projectId, cacheKey);
    if (cached) {
      const saved = await this.store.checkpointStep(this.run.id, this.lease, {
        stepKey: rowKey,
        stepVersion: definition.version,
        kind: definition.kind,
        cacheKey,
        status: "completed",
        reusedStepId: cached.id,
        validation: [...cached.validation],
        usage: { reused: true, modelCalls: 0 },
      });
      if (!saved) throw new RunStopped();
      this.steps.set(rowKey, saved);
      this.count("cacheHits");
      this.stepChecks.push(...cached.validation.map(checkFromJson));
      return this.remember(rowKey, cached.output) as T;
    }
    const started = now(this.deps);
    const running: StepWrite = {
      stepKey: rowKey,
      stepVersion: definition.version,
      kind: definition.kind,
      cacheKey,
      status: "running",
    };
    if (!(await this.store.checkpointStep(this.run.id, this.lease, running)))
      throw new RunStopped();
    let raw: unknown;
    try {
      raw = await this.keptAlive(() =>
        definition.kind === "model" ? this.modelSlots.run(compute) : compute(),
      );
    } catch (err) {
      if (err instanceof RunStopped) throw err;
      await this.store.checkpointStep(this.run.id, this.lease, {
        ...running,
        status: "failed",
        error: (err as Error)?.constructor?.name ?? "Error",
      });
      throw err;
    }
    const result: StepResult = isStepResult(raw) ? raw : { output: raw };
    const usage = Object.fromEntries(
      Object.entries(result.usage ?? {}).map(([k, v]) => [String(k), Math.trunc(v)]),
    );
    const validation = result.validation ?? [];
    const failed = validation.filter((c) => c.status === "failed");
    this.count("modelCalls", result.modelCalls ?? 0);
    for (const [name, value] of Object.entries(usage)) this.count(`tokens.${name}`, value);
    this.count(`steps.${definition.kind}`);
    const saved = await this.store.checkpointStep(this.run.id, this.lease, {
      ...running,
      status: failed.length ? "failed" : "completed",
      output: result.output,
      checkpoint: result.checkpoint ?? null,
      validation: validation.map(checkJson),
      error: failed.length ? "checks failed" : null,
      usage: {
        ...usage,
        modelCalls: result.modelCalls ?? 0,
        seconds: Math.round(now(this.deps) - started) / 1000,
      },
    });
    if (!saved) throw new RunStopped();
    this.steps.set(rowKey, saved);
    if (failed.length) throw new ValidationFailed([...validation]);
    this.stepChecks.push(...validation);
    return this.remember(rowKey, result.output) as T;
  }

  private remember(rowKey: string, output: unknown): unknown {
    this.outputs.set(rowKey, contentHash(output));
    return output;
  }

  private lineage(key: string): string {
    return `${this.recipe.id}/${this.scopeKey}/${key}`;
  }

  /** Stages one output object; `key` is its lineage key within this recipe and scope. */
  async emit(
    typeId: string,
    key: string,
    payload: Json,
    o: {
      sourceRefs?: readonly SourceRef[];
      inputRevisionIds?: readonly string[];
      embeddingRefs?: Json | null;
      extra?: Json | null;
    } = {},
  ): Promise<ObjectRevision> {
    if (!this.recipe.outputTypes.includes(typeId))
      throw new AnalysisValidationError(`recipe ${this.recipe.id} does not produce ${typeId}`);
    const inputs = [...(o.inputRevisionIds ?? [])];
    const allowed = new Set(this.inputRevisionIds);
    const stray = inputs.filter((r) => !allowed.has(r));
    if (stray.length)
      throw new AnalysisValidationError(
        `${stray.length} input revisions are not pinned inputs of this run`,
      );
    const staged = await this.revisions.stageGenerated(this.run, this.lease, {
      typeId,
      lineageKey: this.lineage(key),
      payload,
      sourceRefs: o.sourceRefs ?? [],
      inputRevisionIds: inputs,
      embeddingRefs: o.embeddingRefs ?? null,
      extra: o.extra ?? null,
    });
    if (!staged) throw new RunStopped();
    const earlier = this.objects.get(staged.object.id);
    if (earlier && earlier.revision.contentHash !== staged.revision.contentHash)
      throw new AnalysisValidationError(
        `${typeId} '${key}' was emitted twice with different content`,
      );
    this.objects.set(staged.object.id, staged);
    this.count(staged.reused ? "objectsReused" : "objectsStaged");
    return staged.revision;
  }

  /** Stages a relation between two exact revisions, each an output of this run or a pinned input. */
  async relate(
    typeId: string,
    from: ObjectRevision,
    to: ObjectRevision,
    o: { basis: RelationBasis; attributes?: Json | null; sourceRefs?: readonly SourceRef[] },
  ): Promise<Relation> {
    const endpoints = new Set([
      ...[...this.objects.values()].map((s) => s.revision.id),
      ...this.inputRevisionIds,
    ]);
    for (const end of [from.id, to.id])
      if (!endpoints.has(end))
        throw new AnalysisValidationError(
          `revision ${end} is neither an output nor a pinned input of this run`,
        );
    const relation = await this.revisions.stageRelation(this.run, this.lease, {
      typeId,
      from,
      to,
      basis: o.basis,
      attributes: o.attributes ?? null,
      sourceRefs: o.sourceRefs ?? [],
    });
    if (!relation) throw new RunStopped();
    this.relations.set(relation.id, relation);
    this.count("relationsStaged");
    return relation;
  }

  /**
   * Objects a host edited while this run worked keep the host's revision: the output names
   * it and relations to this run's revision point at it instead. False when an object
   * changed any other way.
   */
  async yieldToAuthored(objectIds: readonly string[]): Promise<boolean> {
    const swapped = new Map<string, ObjectRevision>();
    for (const objectId of objectIds) {
      const staged = this.objects.get(objectId);
      const record = await this.store.getObject(objectId);
      const headId = record?.currentRevisionId ?? null;
      const head = headId
        ? ((await this.store.getRevisions(this.projectId, [headId])).get(headId) ?? null)
        : null;
      if (!staged || !record || !head || head.provenance.origin !== "authored") return false;
      swapped.set(staged.revision.id, head);
      this.objects.set(objectId, { object: record, revision: head, reused: true });
    }
    const moved = [...this.relations.values()].filter(
      (r) => swapped.has(r.fromRevisionId) || swapped.has(r.toRevisionId),
    );
    if (!moved.length) return true;
    const known = new Map([...this.objects.values()].map((s) => [s.revision.id, s.revision]));
    for (const [id, r] of await this.store.getRevisions(this.projectId, this.inputRevisionIds))
      known.set(id, r);
    for (const relation of moved) {
      this.relations.delete(relation.id);
      const ends = [relation.fromRevisionId, relation.toRevisionId].map(
        (end) => swapped.get(end) ?? (known.get(end) as ObjectRevision),
      );
      await this.relate(relation.type, ends[0] as ObjectRevision, ends[1] as ObjectRevision, {
        basis: relation.basis,
        attributes: relation.attributes,
        sourceRefs: ((relation.provenance.sourceRefs as Json[] | undefined) ?? []).map(
          sourceRefFromJson,
        ),
      });
    }
    return true;
  }

  /** A dependency's pinned output revisions (by input name), or every pinned input, in manifest order. */
  async inputRevisions(name: string | null = null): Promise<ObjectRevision[]> {
    let ids: string[];
    if (name !== null) {
      const dep = this.dependencies.get(name);
      if (!dep)
        throw new AnalysisValidationError(`recipe ${this.recipe.id} has no input named '${name}'`);
      ids = dep.revisionIds;
    } else ids = this.inputRevisionIds;
    const found = await this.store.getRevisions(this.projectId, ids);
    return ids.filter((id) => found.has(id)).map((id) => found.get(id) as ObjectRevision);
  }

  candidateManifest(checks: readonly CheckOutcome[]): Json {
    const objects = [...this.objects.values()]
      .map((s) => ({ objectId: s.object.id, revisionId: s.revision.id, type: s.revision.type }))
      .sort((a, b) => (a.objectId < b.objectId ? -1 : a.objectId > b.objectId ? 1 : 0));
    const relations = [...this.relations.values()]
      .map((r) => ({
        relationId: r.id,
        type: r.type,
        from: r.fromRevisionId,
        to: r.toRevisionId,
        contentHash: r.contentHash,
      }))
      .sort((a, b) => (a.relationId < b.relationId ? -1 : a.relationId > b.relationId ? 1 : 0));
    const body = {
      version: MANIFEST_VERSION,
      hashVersion: HASH_VERSION,
      recipe: { id: this.recipe.id, version: this.recipe.version },
      scope: { id: this.run.scopeId, key: this.scopeKey },
      epoch: this.run.epoch,
      objects,
      relations,
      inputs: {
        fingerprint: this.run.inputFingerprint,
        revisionIds: sortedStrings(this.inputRevisionIds),
        dependencies: { ...((this.inputManifest.dependencies as Json | undefined) ?? {}) },
      },
    };
    return {
      ...body,
      runId: this.run.id,
      checks: checks.map(checkJson),
      contentHash: contentHash(body),
    };
  }

  async validate(): Promise<CheckOutcome[]> {
    const checks: CheckOutcome[] = [];
    const invalid: string[] = [];
    for (const staged of this.objects.values()) {
      try {
        validatePayload(staged.revision.type, staged.revision.payload);
      } catch (err) {
        if (!(err instanceof AnalysisValidationError)) throw err;
        invalid.push(staged.revision.id);
      }
    }
    checks.push({
      check: "schema",
      status: invalid.length ? "failed" : "passed",
      evidence: { revisions: this.objects.size, invalid },
    });
    const endpoints = new Set([
      ...[...this.objects.values()].map((s) => s.revision.id),
      ...this.inputRevisionIds,
    ]);
    const dangling = [...this.relations.values()]
      .filter((r) => !endpoints.has(r.fromRevisionId) || !endpoints.has(r.toRevisionId))
      .map((r) => r.id);
    checks.push({
      check: "references",
      status: dangling.length ? "failed" : "passed",
      evidence: { relations: this.relations.size, dangling },
    });
    const embeddingIds = sortedStrings(
      new Set(
        [...this.objects.values()]
          .map((s) => s.revision.embeddingRefs?.embeddingId)
          .filter(Boolean)
          .map(String),
      ),
    );
    if (embeddingIds.length) {
      const durable = await this.store.vectorsByIds(this.projectId, embeddingIds);
      const missing = embeddingIds.filter((id) => !durable.has(id));
      checks.push({
        check: "embeddings-durable",
        status: missing.length ? "failed" : "passed",
        evidence: { embeddings: embeddingIds.length, missing },
      });
    }
    checks.push(...this.stepChecks);
    if (this.recipe.validate) checks.push(...(await this.recipe.validate(this)));
    return checks;
  }
}

function leafErrors(err: unknown): unknown[] {
  if (err instanceof AggregateError) return err.errors.flatMap(leafErrors);
  return [err];
}

/** What the page may show about a failed run: plain, no content. */
export function failureMessage(err: unknown): string {
  if (err instanceof RecipeFailed) return err.message;
  if (err instanceof ValidationFailed || err instanceof PublicationRejected)
    return "The output failed validation.";
  if (err instanceof AnalysisValidationError)
    return "The recipe produced output it may not publish.";
  if (err instanceof AnalysisStoreError) return "Saving the analysis failed.";
  return "Running the recipe failed.";
}

/**
 * Each dependency's exact ready output: the runs named in the pinned input manifest, or,
 * for a run that waited, the runs it waited on. Never a newer output substituted silently.
 */
async function pinDependencies(store: AnalysisStore, recipe: Recipe, run: Run, scopeKey: string) {
  const plan = buildPlan(recipe.id, scopeKey, run.parameters);
  const names = rootNode(plan).dependencies;
  const out = new Map<string, PinnedOutput>();
  if (!names.length) return out;
  const recorded = (run.inputManifest?.dependencies as Json | undefined) ?? {};
  const ids = run.inputManifest
    ? Object.values(recorded).map((d) => String((d as Json).runId))
    : [...run.dependsOn];
  const byScope = new Map<string, Run>();
  for (const id of ids) {
    const r = await store.getRun(id);
    if (r) byScope.set(r.scopeId, r);
  }
  for (const [name, depKey] of names) {
    const node = planNode(plan, depKey);
    const scope = await store.findScope({
      projectId: run.projectId,
      kind: "producer",
      ownerId: node.recipeId,
      scopeKey: node.scopeKey,
    });
    const chosen = scope ? byScope.get(scope.id) : undefined;
    if (chosen?.status !== "ready" || !chosen.outputManifest)
      throw new RecipeFailed("A recipe this run depends on has no ready output.");
    if (run.inputManifest) {
      // Replay what was withdrawn when the inputs were pinned.
      const withdrawn = (
        ((recorded[name] as Json | undefined)?.withdrawnObjectIds as unknown[]) ?? []
      ).map(String);
      out.set(name, pinned(name, node.recipeId, node.scopeKey, chosen, withdrawn));
    } else out.set(name, await pin(store, name, node.recipeId, node.scopeKey, chosen));
  }
  return out;
}

export type WorkerOutcome =
  | "ready"
  | "needs_review"
  | "superseded"
  | "failed"
  | "cancelled"
  | "stopped"
  | "deferred"
  | "skipped";

/**
 * Claims a run under `lease`, or confirms this lease still holds it (a resumed
 * workflow re-enters with the lease its claim step recorded). Idempotent for one lease.
 */
export async function claim(
  deps: ExecutorDeps,
  runId: string,
  lease: string,
): Promise<{ outcome: "claimed" | "busy" | "inactive"; run: Run | null }> {
  const { store } = deps;
  const existing = await store.getRun(runId);
  if (!existing || !["queued", "running"].includes(existing.status))
    return { outcome: "inactive", run: existing };
  if (existing.status === "running" && existing.lease === lease) {
    if (await store.heartbeatRun(runId, lease, existing.progress))
      return { outcome: "claimed", run: existing };
  }
  let recipe: Recipe | null = null;
  try {
    recipe = getRecipe(existing.recipeId);
  } catch (err) {
    if (!(err instanceof UnknownRecipe)) throw err;
  }
  return store.claimRun(runId, lease, recipe?.maxRunning ?? null);
}

/** Executes a claimed run to its end under `lease`: pin, run, validate, publish or settle. */
export async function execute(
  deps: ExecutorDeps,
  runId: string,
  lease: string,
): Promise<WorkerOutcome> {
  const { store } = deps;
  const claimed = await claim(deps, runId, lease);
  if (claimed.outcome === "busy") return "deferred";
  if (claimed.outcome !== "claimed" || !claimed.run) {
    const current = claimed.run;
    // A resumed workflow whose run already published or settled has nothing left to do.
    if (current?.status === "ready") return "ready";
    return current && ["failed", "cancelled", "superseded", "needs_review"].includes(current.status)
      ? (current.status as WorkerOutcome)
      : "skipped";
  }
  let run = claimed.run;
  let recipe: Recipe | null = null;
  try {
    recipe = getRecipe(run.recipeId);
  } catch (err) {
    if (!(err instanceof UnknownRecipe)) throw err;
  }
  const scope = await store.getScope(run.scopeId);
  const scopeKey = scope?.scopeKey ?? "";
  let ctx: RecipeContext | null = null;
  try {
    if (!recipe || recipe.version !== run.recipeVersion)
      throw new RecipeFailed("This recipe version is no longer available.");
    const dependencies = await pinDependencies(store, recipe, run, scopeKey);
    if (!run.inputManifest) {
      const manifest = await resolveInputs(recipe, {
        projectId: run.projectId,
        scopeKey,
        parameters: run.parameters,
        selected: ((run.context.selectedRevisionIds as unknown[] | undefined) ?? []).map(String),
        dependencies,
        services: deps.services,
      });
      const fp = contentHash(manifest);
      if (!(await store.pinInputs(run.id, lease, manifest, fp))) throw new RunStopped();
      run = { ...run, inputManifest: manifest, inputFingerprint: fp };
    }
    ctx = new RecipeContext(deps, recipe, run, lease, scopeKey, dependencies);
    await ctx.loadSteps();
    return await executeRecipe(ctx);
  } catch (err) {
    return settleFailure(deps, run, lease, ctx, err);
  }
}

async function executeRecipe(ctx: RecipeContext): Promise<WorkerOutcome> {
  const { store, run } = ctx;
  const deps = ctx.deps;
  await ctx.progress("running", { force: true });
  await ctx.recipe.execute(ctx);
  await ctx.progress("validating", { force: true });
  let manifest: Json = {};
  let checkDocs: Json[] = [];
  let result: Awaited<ReturnType<AnalysisStore["publishRun"]>> = { outcome: "inactive" };
  for (let attempt = 1; attempt <= PUBLISH_ATTEMPTS; attempt++) {
    const checks = await ctx.validate();
    if (checks.some((c) => c.status === "failed")) throw new ValidationFailed(checks);
    manifest = ctx.candidateManifest(checks);
    checkDocs = checks.map(checkJson);
    if (checks.some((c) => c.status === "needs_review"))
      return needsReview(ctx, manifest, checkDocs);
    result = await store.publishRun(run.id, ctx.lease, {
      manifest,
      checks: checkDocs,
      metrics: ctx.metricsDoc(),
    });
    // A host edited one of this run's objects while it worked: the edit stands.
    if (result.outcome !== "conflict" || attempt === PUBLISH_ATTEMPTS) break;
    if (!(await ctx.yieldToAuthored(result.conflicts ?? []))) break;
  }
  if (result.outcome === "inactive") throw new RunStopped();
  if (result.outcome === "conflict") {
    checkDocs.push(
      checkJson({
        check: "object-heads",
        status: "needs_review",
        evidence: { objects: [...(result.conflicts ?? [])] },
        message: "An object changed while the run was working.",
      }),
    );
    return needsReview(ctx, manifest, checkDocs);
  }
  if (result.outcome === "superseded") {
    await deps.publishEvent(run.projectId, {
      type: "superseded",
      run_id: run.id,
      recipe_id: run.recipeId,
    });
    return "superseded";
  }
  deps.logger?.info(
    {
      run_id: run.id,
      recipe_id: run.recipeId,
      recipe_version: run.recipeVersion,
      project_id: run.projectId,
      objects: ((manifest.objects as unknown[]) ?? []).length,
      relations: ((manifest.relations as unknown[]) ?? []).length,
      metrics: ctx.metricsDoc(),
    },
    "analysis run ready",
  );
  await deps.publishEvent(run.projectId, {
    type: "ready",
    run_id: run.id,
    recipe_id: run.recipeId,
    sequence: result.sequence ?? null,
  });
  return "ready";
}

async function needsReview(
  ctx: RecipeContext,
  manifest: Json,
  checks: Json[],
): Promise<WorkerOutcome> {
  if (
    !(await ctx.store.finishRun(ctx.run.id, ctx.lease, {
      status: "needs_review",
      checks,
      metrics: ctx.metricsDoc(),
      candidateManifest: manifest,
    }))
  )
    throw new RunStopped();
  await ctx.deps.publishEvent(ctx.run.projectId, {
    type: "needs_review",
    run_id: ctx.run.id,
    recipe_id: ctx.run.recipeId,
  });
  return "needs_review";
}

/** A worker that may no longer write settles the run as superseded when it was overtaken. */
async function settleStopped(deps: ExecutorDeps, run: Run, lease: string): Promise<WorkerOutcome> {
  const current = await deps.store.getRun(run.id);
  const scope = await deps.store.getScope(run.scopeId);
  if (
    current &&
    current.status === "running" &&
    current.lease === lease &&
    scope &&
    scope.currentRequestOrder !== null &&
    scope.currentRequestOrder >= current.requestOrder
  ) {
    if (await deps.store.finishRun(run.id, lease, { status: "superseded" })) {
      await deps.publishEvent(run.projectId, { type: "superseded", run_id: run.id });
      return "superseded";
    }
  }
  deps.logger?.info({ run_id: run.id }, "analysis run stopped: no longer this worker's");
  return "stopped";
}

async function settleFailure(
  deps: ExecutorDeps,
  run: Run,
  lease: string,
  ctx: RecipeContext | null,
  raised: unknown,
): Promise<WorkerOutcome> {
  const leaves = leafErrors(raised);
  if (leaves.some((l) => l instanceof RunStopped)) return settleStopped(deps, run, lease);
  const err = leaves[0];
  let checks: Json[] | null = err instanceof ValidationFailed ? err.checks.map(checkJson) : null;
  if (err instanceof PublicationRejected)
    checks = [
      checkJson({
        check: "publication-references",
        status: "failed",
        evidence: { reasons: err.reasons },
      }),
    ];
  let recorded = false;
  try {
    recorded = await deps.store.finishRun(run.id, lease, {
      status: "failed",
      error: failureMessage(err),
      checks,
      metrics: ctx ? ctx.metricsDoc() : null,
    });
  } catch (e) {
    if (!(e instanceof AnalysisStoreError)) throw e;
    deps.logger?.error({ run_id: run.id }, "analysis run: could not record the failure");
  }
  if (!recorded) return settleStopped(deps, run, lease);
  // Only messages this package wrote are logged: a provider's error can quote its input.
  const ours =
    err instanceof RecipeFailed ||
    err instanceof ValidationFailed ||
    err instanceof AnalysisValidationError ||
    err instanceof AnalysisStoreError;
  deps.logger?.error(
    {
      run_id: run.id,
      recipe_id: run.recipeId,
      project_id: run.projectId,
      error: (err as Error)?.constructor?.name,
      detail: ours ? String((err as Error).message).slice(0, 500) : "(detail withheld)",
    },
    "analysis run failed",
  );
  try {
    await deps.store.wakeWaitingRuns(run.projectId);
  } catch (e) {
    if (!(e instanceof AnalysisStoreError)) throw e;
    deps.logger?.warn({ run_id: run.id }, "analysis run: dependants not settled; the sweep will");
  }
  await deps.publishEvent(run.projectId, {
    type: "failed",
    run_id: run.id,
    recipe_id: run.recipeId,
  });
  return "failed";
}

/**
 * For a caller already inside a worker (a fact-check recording its verdict): the same
 * request, runs, steps and publication, executed in this process. Dependency runs
 * execute first, in plan order.
 */
export async function executeInline(
  request: RunRequest,
  base: ExecutorDeps,
): Promise<RequestOutcome> {
  const deps: ExecutorDeps = { ...base, dispatchRun: null };
  const outcome = await requestRun(request, deps);
  for (const pending of [...outcome.dependencies, outcome.run]) {
    let current = await deps.store.getRun(pending.id);
    if (!current) continue;
    if (current.status === "waiting_for_inputs") {
      await deps.store.wakeWaitingRuns(current.projectId);
      current = await deps.store.getRun(pending.id);
    }
    if (current?.status === "queued")
      await execute(deps, current.id, crypto.randomUUID().replaceAll("-", ""));
  }
  const final = await deps.store.getRun(outcome.run.id);
  return { ...outcome, run: final ?? outcome.run };
}
