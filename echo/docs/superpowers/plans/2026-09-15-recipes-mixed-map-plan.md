# Plan: recipes, shared analysis objects and the mixed map

Spec: `docs/superpowers/specs/2026-09-15-analysis-objects-and-mixed-map.md`. Branch `recipes`, from PR #1074 head `a834a304`. Local only; nothing is pushed.

This plan fixes module layout, contracts and file ownership so several agents can work at once. Where it resolves something the spec leaves open, it says so under "Decisions". Where it departs from the spec, it says so under "Deviations".

## Decisions

1. **Package.** `server/dembrane/analysis/` holds the shared lifecycle: `db.py` (connections, per-loop bound, transactions), `store.py` (SQL store), `contracts.py` (dataclasses and the store protocol), `registry.py`, `types.py` (object and relation types, payload schemas, attribute metadata), `hashing.py` (canonical JSON and content hashes), `planner.py` (dependency plan, cycle check), `revisions.py` (the one revision-writing service), `executor.py` (request, run, steps, publish), `outbox.py` (dispatch), `snapshots.py` (view manifests), `embeddings.py` (shared embedding service over `map_embedding`), `budgets.py`, and `recipes/` (one module per built-in recipe).
2. **Ids.** Scopes, runs, steps, objects, revisions, relations, snapshots and outbox events use UUIDs. Backfill uses `uuid5` from a fixed namespace over legacy ids so repeat imports map identically.
3. **Content hash.** `sha256` over canonical JSON: UTF-8, NFC-normalised strings, sorted keys, no insignificant whitespace, floats as repr. Stored with `hash_version = "c14n-v1"`. A hash identifies reusable computation, never identity.
4. **Scopes.** `analysis_scope` has `kind` (`producer` or `view`), `project_id`, `recipe_id` (producers) or `view_id` (views), and `scope_key` (`project`, `conversation:<id>`, `report:<id>`). A producer scope points at its current ready run; a view scope points at its current snapshot. Both rows are the publication lock.
5. **Leases.** `analysis_run.lease` is its own column (new table, no JSON). Every checkpoint, heartbeat, fail and publish compares it.
6. **Request order.** `analysis_scope.next_request_order` is incremented in the same statement that creates a run. Publication refuses a run whose order is below the scope's current ready run.
7. **Publication.** One psycopg transaction: `SELECT ... FOR UPDATE` on the scope, recheck lease, order and expected object heads, validate manifest references in SQL, write the manifest, mark the run ready, advance scope and object heads, insert the outbox event. No model or network call inside.
8. **Outbox.** After commit the executor enqueues `task_analysis_outbox_dispatch` (best effort). A scheduler job every minute sweeps undispatched events with `FOR UPDATE SKIP LOCKED`, the pattern `task_forward_support_requests` already uses. Dispatch publishes the live event, wakes waiting runs and assembles following view snapshots. Each consumer is idempotent on event id.
9. **Waiting runs.** A run whose dependency is not ready is stored as `waiting_for_inputs` with the dependency run ids and holds no worker. The dependency's publication event wakes it; it then pins that exact output manifest.
10. **Step cache.** `analysis_step.cache_key` = hash of recipe id and version, step key and version, prompt and check versions, input revision fingerprints, parameters, context and voice versions, model deployment config, and the generation epoch for model stages. Reuse is limited to completed steps in the same project.
11. **Inline execution.** A caller already inside a worker (the popcorn tick) runs a recipe inline through the same executor functions, creating the same run and step rows and publishing through the same transaction. This keeps popcorn's first phrases fast without a second path.
12. **Writer ownership.** `analysis_scope.writer` (`legacy` or `analysis`) and `writer_fence` (integer). Legacy writers check it before committing; transfer waits for the popcorn run lock to be free, then bumps the fence.
13. **Map compatibility.** `map_result` gains `manifest_version` (1 or 2) and `snapshot_id`. v1 rows stay readable. v2 rows reference an `analysis_snapshot`; result URLs keep working.
14. **Assessments.** A completed fact-check appends an `analysis_object_revision` of type `fact_check_assessment` with an `assesses` relation to the claim revision. `map_fact_check` stays the operational current-state table.
15. **Budgets.** Defaults live in `dembrane/analysis/budgets.py` (`nodeLimit` 150, `edgeLimit` 450, optional deployment ceilings from settings) and reach the frontend in the Map payload. The frontend never hard-codes them.
16. **Directus indexes.** Composite and partial indexes live in the SQL migration with names that are not `{table}_{field}_index`. No single-column index is created in SQL. This is the pattern `add_map_vectors.sql` already proved survives a push.
17. **Deduplication.** Candidates come from embedding complete linkage (strategy `emb-complete-linkage-v1`, recorded with its threshold, maximum group size and coverage). One verification call per candidate group returns sub-groups, each with a proposed statement checked against every member. Unverified or uncertain members stay separate. Singletons pass through.
18. **Tension payload.** The deck reads `knot`. The tension payload stores `poleA`, `poleB`, `knot`, `toResolve` and quote references; the Map inspector labels `knot` as the narrative.

## Merge dependency

`recipes` contains every commit of PR #1074 and merges after it. If #1074 changes during review, `recipes` is rebased onto its new head.

## Frontend facts that shape M4

- `nodeRadius` is one scalar in both renderers: circle `r` (times 2 when selected, 1.25 when recent), the collision force and auto-fit padding. Per-type size means a per-node radius accessor used in all three places.
- Filtering must narrow `nodes` before `useGeometryNodes`, so a type or scope change recomputes geometry once and a color change never does.
- The MST is built three times on the main thread (`MapPage.tsx:260` for titles, `MstGraph.tsx:1171`, `LocalMapGraph.tsx:290`), `computeKNN` is O(n²·d), and there is no node or edge cap. The layout worker computes distances, MST and neighbours once per request and both renderers and titles consume that result.
- `state/settings.ts` drops unknown `colorBy` values; adding `type` needs the allow-list and a versioned migration that keeps existing values and custom budgets.
- `Legend.tsx` hard-codes rows per mode; it moves to the attribute definitions.
- There is no result id or filter in the URL today; M4 adds `types`, `scope` and color mode as search params.

## Resolved during M2

- **Tensions, arguments without verbatim evidence** leave the collision stage entirely and are counted in coverage; they could never hold a pole.
- **Tensions, an argument on both poles** after facet merging is skipped and counted, not silently dropped.
- **Usage.** The executor wraps each recipe's `generate` callable to capture tokens; recipes keep returning answers only.
- **Result-local keys.** A recipe may name its outputs with result-local keys (`x1`); the executor maps them to object and revision ids and rewrites relation endpoints before staging.
- **Holders in prompts** are conversation labels, never participant names.
- **The collisions prompt** is reused as is for argument listings; real local runs in M6 decide whether a `tensions-collisions` variant is needed.
- **`tests/analysis/__init__.py`** is required so pytest can import `dembrane` from that folder.
- **Deduplication module** is `analysis/recipes/deduplication.py` (not `deduplicated_arguments.py`). The model sees member labels `m1..mN`, never database ids; identical normalised text with the same kind and valence merges as `exact_match` without a call.
- **A failed or malformed verification call** keeps its group separate and does not block publication; coverage lists the unverified groups, and a retry re-verifies them. The run is not `needs_review` for this alone, because no merge was made on an unchecked answer.
- **Candidate thresholds** were calibrated as merge thresholds. M6 recalibrates them for candidate discovery with `eval_deduplication.py --real-embeddings`.
- **The similarity matrix** is quadratic per kind and valence partition: fine for hundreds of arguments. The benchmark ladder decides whether indexed neighbour discovery is needed; pairs split across chunks of an oversized cluster are only flagged as `truncated`.
- **Model deployment** is recorded by the executor next to each recipe's prompt fingerprint.

## Deviations from the spec

- The spec names a tension `narrative`; the live deck contract calls it `knot`. The payload keeps `knot` and the deck adapter is unchanged (decision 18).
- The spec puts view heads implicitly on snapshots; this plan stores them on view scopes (decision 4) so one row is the lock for both kinds of publication.

## Milestones and ownership

Agents stay inside their files. None commits; the lead verifies and commits per milestone.

### M1 Foundation (one agent, sequential)

Owns `server/dembrane/analysis/{db,contracts,store,registry,types,hashing,planner,revisions,executor,outbox,snapshots,embeddings,budgets}.py`, `server/tests/analysis/` (unit and Postgres integration), `directus/migrations/add_analysis_schema.py`, `directus/migrations/add_analysis_constraints.sql`, the generated snapshot files for the eight collections plus the two new `map_result` fields, the scheduler and actor registration lines for the executor and outbox in `tasks.py`/`scheduler.py`, and step 6 of `docs/database_migrations.md`.

Acceptance: fresh install and second application of both migrations; a snapshot round trip keeps SQL columns and indexes; unit tests with a fake store and Postgres tests with barrier races for idempotency, request order, stale lease, expected head conflicts, publication rollback, outbox retry and duplicate dispatch; a fixture recipe runs end to end through the SQL store.

### M2 Producers, in parallel after M1

- **Arguments** owns `analysis/recipes/arguments.py`, moves extraction out of `map/generate.py` and `map/recipe.py` (consolidation leaves), and makes `map/service.request_generation` delegate. Existing Map tests migrate alongside.
- **Deduplicated arguments** owns `analysis/recipes/deduplicated_arguments.py`, its prompt, and a regression corpus under `tests/analysis/corpus/` (duplicates, near-duplicates, qualified statements, conflicting positions, minority arguments; A≈B≈C chains).
- **Tensions** owns `analysis/recipes/tensions.py`, reuses `popcorn/tensions.py` collision, verify, dedupe and write stages over pinned argument revisions, emits `supports_pole_a`/`supports_pole_b` relations, and reports coverage gaps.

### M3 Snapshot, Map v2 and migration (one agent)

Owns `map/service.py` payload v2, `api/v2/bff/map.py` (graph data with budgets, counts before vectors, objects and relations endpoints, recipe metadata and run inspection routes), `analysis/backfill.py` (legacy `map_result` import, no model calls, deterministic ids), and the tension deck adapter in `popcorn/bundle.py`.

### M4 Frontend, in parallel with M3 against the payload contract below

- **Data and panels** owns `components/map/{types.ts,data/*,hooks/*,state/settings*,panels/*,MapPage.tsx,graph/nodeStyle.ts,attributes.ts,budgets.ts}`: typed nodes, attribute definitions and style resolver, Objects filter with counts and URL state, color by Type/Valence/Factual status, budgets settings with validation and migration, empty/small/over-budget states, inspector for each type with provenance and history.
- **Renderers and layout** owns `components/map/{renderers/*,graph/mst.ts,graph/localMap.ts,graph/forces.ts,graph/layout.ts,layout/*}`: per-node radius, relationship overlays inside the edge budget with N−1 MST edges kept, a cancellable layout worker keyed by request id, and a benchmark harness.

### M5 Popcorn and stakeholders (one agent)

Owns `popcorn/ticks.py`, `popcorn/service.py`, `popcorn/bundle.py` (after M3), `analysis/recipes/{popcorn,stakeholders}.py`, legacy popcorn import, writer transfer and fencing.

### M6 Extension proof and acceptance (lead plus one agent)

Fixture integration recipe, the failure and reconstruction test matrix from the spec, benchmark ladder, real local runs, and the traceable example.

## Map payload v2 (contract for M3 and M4)

```ts
type MapPayloadV2 = {
  version: 2;
  snapshot: { id: string; createdAt: string; parentId: string | null; stale: StaleRef[] };
  budgets: { nodeLimit: number; edgeLimit: number; defaults: { nodeLimit: number; edgeLimit: number }; ceilings?: { nodeLimit?: number; edgeLimit?: number } };
  counts: Record<ObjectType, number>;            // in the snapshot, before filtering
  scope: { types: ObjectType[]; resultScope?: string };
  overBudget: boolean;                            // true: nodes and vectors omitted
  embedding: { key: string; model: string; dims: number };
  nodes: Array<{
    objectId: string; revisionId: string; type: ObjectType;
    label: string; detail: unknown;              // type-specific projection
    attributes: { valence?: "positive" | "negative" | "neutral"; epistemicKind?: "argument" | "claim" };
    factCheck?: { eligible: boolean; claimKey?: string; assessmentRevisionId?: string };
    provenance: { runId: string; recipeId?: string; recipeVersion?: string; origin: "generated" | "authored" | "imported" };
    embedding: number[] | null;                  // null: listed as unplaced
  }>;
  relations: Array<{ id: string; type: string; from: string; to: string; basis: "extracted" | "inferred" | "authored" }>; // revision ids
  unplaced: string[];                             // revision ids without vectors
};
type ObjectType = "argument" | "deduplicated_argument" | "popcorn" | "tension" | "stakeholder";
```

Legacy v1 results are served through the same shape with `type: "argument"` and legacy provenance.
