# Recipes, shared analysis objects and a map of multiple types

Status: implementation spec, including the chosen reliability and scaling architecture. This task writes the spec only. Build the subsequent change locally for review, preserving unrelated work; do not push or deploy until requested.

## Baseline and intent

Extend [PR #1074, Map adds linked argument views and moves live updates to SSE](https://github.com/Dembrane/echo/pull/1074), inspected at `a834a3047665c7c473eb6ab7897fb9910f115297`. It was open when inspected. The Map and Popcorn modules inspected locally at `9b54601d` matched that PR head. Verify the implementation checkout against this baseline before starting. This is a follow-on specification, not a replacement for the delivered Map design or a requirement to repeat its implementation.

An analyst can put arguments, popcorn excerpts, tensions and stakeholders on the same linked MST and local map, choose which types are visible, and map color to type, valence or factual status. Tensions appear larger and expose the arguments that establish each pole. Existing presentation tabs read those same generated objects.

The underlying change is a shared lifecycle for typed, revisioned objects. Recipes retain their own instructions and output constraints. One entry point coordinates generation, validation, provenance, persistence and progress; it does not mean one prompt, one model call, or generating every type every time. Adding an integration-specific output should reuse this lifecycle without modifying graph algorithms or creating another storage system.

The implementation must preserve these invariants:

- Object identity, immutable content revision and reusable-computation hash are separate keys.
- Every completed output can be traced to the exact inputs, model outputs and checks that produced it.
- A result becomes current atomically; unfinished writes and failed attempts never replace a ready result.
- Every rendered or shared result resolves through one immutable snapshot, including its relevant assessments and view configuration.
- Deduplication preserves meaning and provenance. It has no target reduction percentage.
- Rendering choices do not modify source objects or silently change an algorithm's meaning.
- Migration has one authoritative writer per producer scope and preserves legacy readers.

## Product direction: Recipes create objects

Use “Recipes” as the product name and introduce a project-level Recipes tab. A recipe describes what analysis happens, in which order, what objects it produces, and how those outputs are checked. Popcorn is one such recipe: its ordered analysis and verification steps produce short, source-grounded objects. Arguments, tensions, stakeholders and reports have different recipes suited to their purpose.

The intended flow is:

```text
Sources and context → Recipe steps and checks → Versioned objects
                                                   ├→ Views in dembrane
                                                   └→ Exports, webhooks and connectors
```

Built-in experiences such as Popcorn, Tensions, Stakeholders, Map and Report provide purpose-designed views for compatible outputs. A recipe may supply several views and destinations, and a view may combine outputs from several recipes. A view or webhook consumes objects; it is not the recipe's execution engine. Preserve this distinction even when the host configures everything in one place.

The Recipes tab is the home for discovering recipes, configuring them for a project, reviewing their ordered steps/prompts and checks, running them, inspecting results and history, and connecting outputs to views or destinations. It is also where hosts can later create their own recipes. Keep these actions available in context: a host using Popcorn can rerun, change timing, inspect or edit results and manage translations there. They do not have to visit Recipes first. Those controls refer to the same configured recipe and objects as the tab.

Distinguish the versioned recipe definition from a project's configured use of it, its individual executions and its output revisions. Store step/check definitions or their immutable version references with each execution, plus check outcomes. Checks include structural schema validation, source verification and recipe-specific review. Record whether output passed, failed or needs review; a model-generated assurance alone is not evidence that verification happened.

A destination binding selects compatible object types, a view/export version and either pinned revisions or an explicit follow-current policy. Scheduling belongs to recipe execution; public visibility belongs to the view or delivery configuration. Re-running an analysis must not implicitly change who can access its results or send a new webhook. Ongoing delivery requires a configured trigger and destination authorization.

## Intended navigation: prepare, present, analyse

The host's sketch establishes product direction, not a finalized route tree or an instruction to move every menu item in the mixed-map change. Before/During/After are helpful journey groupings, not restrictions on when an action is available. In particular, Map can serve presentation and analysis, and Ask remains available throughout. References from multiple groups open the same underlying work, with controls appropriate to the moment.

| Level or journey | Intended contents and purpose |
|---|---|
| Organization | Organization-wide services such as Procurement and Training. The remaining organization menu is still open. |
| Workspace | Where projects live. |
| Project, always available | Ask and Overview. Recipes is an additional project-level tab; its exact sidebar position remains to be settled alongside the journey groups. |
| Before: Prepare | Session preparation, connected context, language and political sensitivities. Portal editor covers introduction text, consent, on-screen content, capabilities such as Socratic dialogue and verification, and the thank-you screen. Configure webhooks and other connectors here. |
| During: Present, Introduction | Today's host-guide material: introduce dembrane, help people feel safe, explain privacy and address concerns about language models. |
| During: Present, Monitor | Help people get on board and show the host where intervention is needed. Mostly host-facing; selected indicators such as the number currently recording may also be shown to the room. |
| During: Present, recipe-driven experiences | Popcorn for feeling heard during a break; Tensions / open space for choosing where to go deeper before another discussion round; Stakeholders for considering who was absent; Argument map for exploring complexity. Each has host controls and a shareable presentation view suited to its purpose. |
| After: Analyse | Ask questions; generate, inspect and share a report, with a read-only view and PDF export; go deeper with the Map's host/analyst tools; review the Audit. |

“Playbook” appeared as a session-preparation placeholder in the sketch. It is not an alternative name for the executable analysis workflows: those are Recipes. Whether broader session preparation retains a separate Playbook label remains a navigation decision.

Recipe-driven host surfaces share access to overview, rerun, temporal behavior, result editing and translation where relevant. Map and report analysis may also expose cluster creation where useful. These actions use shared capabilities; each experience chooses which controls help its host. Editing and suggestions follow permissions wherever invoked. Presentation/read-only surfaces receive the intended visible output and controls, not the entire host workspace.

Audit makes the work inspectable: actions, actors, times, recipe/check versions and result changes are traceable to their source. Editorial changes must be obvious for review, with original and revised content available to authorized reviewers. The aim is candid, trusted sharing of outcomes, including transparent corrections of sensitive wording.

The Recipes tab, full navigation reshuffle, report workflow and host/presentation variants are intended product work beyond this mixed-map foundation. Do not implement a second recipe system later to enable the tab. Expose recipe metadata, configuration, executions, checks and outputs through the common services now so the tab and contextual controls can use them.

## What already exists, and what changes

| Existing implementation | Extension |
|---|---|
| `map/generate.py`: extraction, resumable progress, bounded embedding, attempt leases and durable publication | Extract the reusable execution lifecycle; register the argument recipe as its first producer. Retain concurrency and stale-worker protections. |
| `map/recipe.py`: grounded argument/claim manifest, content-derived IDs and consolidation | Preserve extraction quality; publish typed objects with durable identity and separate immutable revisions. |
| `map_result`, `map_embedding`, `map_fact_check` | Preserve existing rows, URLs and vector cache. Add shared object storage and a versioned Map projection over exact object revisions. |
| `types.ts` and `data/adapter.ts`: argument/claim nodes | Adapt typed object revisions to graph nodes. Separate object type from factual eligibility. |
| `graph/nodeStyle.ts`, `renderers/hooks.ts`, `Legend.tsx` | Share attribute mappings and per-node sizing across both renderers, panels and legends. |
| `interactionStore.tsx`, `useGeometryNodes`, MST and local-map algorithms | Preserve linked interactions and metadata-only updates without graph reconstruction. |
| `popcorn/ticks.py`: independent tension and stakeholder transcript passes | Route producers through the shared lifecycle. Tension generation consumes saved arguments with access to their original evidence. |

This is a bounded backend refactor plus frontend adapters and controls. It needs more than extending the current `MapKind` union, but does not require a frontend rewrite or the wider Analysis/Library restructure.

## The host's experience

- Add an “Objects” filter with Arguments, Deduplicated arguments, Popcorn, Tensions and Stakeholders, including counts. Both argument types can contain arguments and claims. Start with available types selected subject to the rendering budget below. When opening a deduplication result, scope the map to its output rather than automatically adding its source arguments too. Remember scope and filter state in the URL.
- Checking a type displays its saved objects. If none exist, show that clearly and offer “Generate tensions” or the appropriate action here. Changing a filter never starts a model call.
- Extend “Color nodes by” to None, Type, Valence and Factual status. Preserve existing preferences and fact-check controls. Supply the same legend and colors in both renderers.
- Render tensions at a proposed default of 1.5 times the base node radius. Use a shared type-style definition; update collision, hit target and selected-node treatment consistently. This size distinguishes type, not importance or evidential strength.
- Selecting a tension shows its two poles, narrative and question to resolve, plus the arguments supporting each side. Selecting a stakeholder shows role, stake, evidence status and evidenced connections. Popcorn shows its original phrase and source evidence. All use the existing inspection panel structure.
- Show explicit relationship lines on selection, visually distinct from proximity edges. A small “Relationships” control exposes connections within the visible-edge budget. Related objects hidden by filters remain listed in the inspector with an action to reveal them; selecting a node does not silently change filters or bypass the node cap.
- Show source, recipe/version and revision history in the inspector. Generation and later editing can be invoked from the relevant experience; storage ownership does not force navigation to an administrative screen.

Keep linked selection, titles, fact-checks, pause/resume, forces, zoom and existing Showcase behavior. No additional event-monitor or presentation redesign is part of this change.

## Rendering budgets

The initial useful target is 50–150 visible nodes. Use configurable `nodeLimit` and `edgeLimit` settings, initially defaulting to 150 nodes and 450 visible edges per renderer. These are starting defaults, not architectural maxima. Hosts can change the budgets in Map settings; keep the chosen budgets with the view settings and apply the same resolved values to both linked renderers and the graph-data request. Deployment defaults can increase as performance improves. Do not scatter literal limits through components, endpoints or tests.

Validate budgets as positive integers before graph work. Require `edgeLimit >= nodeLimit - 1` so the admitted MST always fits; make any required adjustment visible in settings. If deployment resource ceilings are needed, expose them explicitly as configuration and explain a rejected setting. A settings/schema migration must preserve custom values rather than resetting them to new defaults. Budget changes affect display scope and computation only, never extraction, persisted objects, evidence or revisions.

Below 50, keep the smaller map available but prioritize a simple result list in the empty/small-result entry state. Do not manufacture nodes to fill space. Zero objects shows an empty state; one object can be inspected without an edge. The range describes where the method is useful, not a minimum evidence requirement.

Above the configured node limit, do not start an oversized layout or silently choose the first N objects. Show the count and current budget, and offer increasing the budget, filtering, narrowing the source/selection, or running the Deduplicate arguments recipe when applicable. Keep the current valid map visible while a new scope or recipe result is prepared. Non-argument-heavy datasets need their own filtering or later consolidation recipe; do not run argument deduplication over incompatible objects. An oversized recipe result remains valid and inspectable in the list.

The configured visible-edge budget includes relationship overlays. Validate the initial 450-edge default on the target devices and raise it through configuration as the implementation improves. Count actual drawn connections; direction duplicates for the same displayed proximity link do not consume separate slots.

- MST: always preserve all N−1 tree edges, up to `nodeLimit - 1`. Its optional relationship overlay uses the remaining edge budget. Do not prune the tree to make room for overlays.
- Local map: preserve its current neighbour computation/physics and the default hidden-neighbour-link presentation. If proximity links are enabled, draw a deterministic subset within the edge budget. Drawing fewer links does not change the local layout's neighbour forces.
- Prioritize explicit connections incident to the selected object, then use stable ordering for remaining relationship lines. Clearly show displayed/available connection counts when the limit is reached. All relationships remain inspectable in the detail list; the host can narrow the scope to see a dense neighbourhood.
- Any future relationship layout uses the same node and visible-edge budgets. Its full in-scope relationships may determine geometry even when some lines are hidden; label that distinction.

Check the node budget before fetching large vector sets or running pairwise layout computation. Paginate/count the underlying collection separately from the bounded graph payload. Colors, labels and selection must not trigger model calls, and expanding evidence in the inspector does not automatically add its source objects as graph nodes.

## Scaling recipes and visualization

Raising the budgets is an intended development path. Separate display budgets from execution budgets: a 150-node view must not limit a recipe to processing 150 source objects, and increasing the view budget must not increase model concurrency or start new recipes. Recipe concurrency, provider quotas, batching and retry limits remain independently configurable.

Build these foundations in the current change:

- Reuse completed recipe stages when their exact inputs, parameters, recipe/prompt/check versions and model configuration match. Source changes invalidate the affected stages and dependants, not every recipe in the project. Preserve the existing full-input semantics of global recipes: a changed argument may require recomputing global deduplication or tensions even when its extraction and other embeddings are reusable.
- Batch compatible embedding and database operations, deduplicate shared dependency work, and enforce backpressure across competing jobs. Progress and checkpoints allow cancellation/resumption without discarding completed work. Record cache hits, model calls/tokens, wall time and processed object counts to identify the expensive stages.
- For deduplication, separate candidate discovery from semantic verification. Avoid a model call for every possible pair; reuse validated exact matches and use bounded candidate sets for likely duplicates. Candidate limits must not silently turn incomplete coverage into a claim that all duplicates were found. Record the candidate strategy/version and coverage limits with the result.
- Move expensive graph computation off the UI thread behind a cancellable computation interface. Key work by object revisions, embeddings, scope and algorithm parameters. Share reusable distance/neighbour/MST results between linked renderers where their inputs and semantics match; keep their distinct layout rules. A stale result must not replace the graph after scope or budget changes.
- Keep geometry, styling and rendering work separate. Reuse positions and graph structure across metadata updates; fetch only the bounded graph data needed, with evidence/details loaded on demand. Measure graph-build time, memory, interaction latency and frame time separately from model latency.

Subsequent optimizations may include memory-efficient exact MST computation, indexed neighbour discovery, incremental layouts, sparse stress objectives, spatial indexing for interaction, and Canvas/WebGL rendering when SVG becomes the bottleneck. Select them using representative benchmarks rather than committing to a new library in this spec. Avoid materializing a dense all-pairs matrix at larger scales unless measurement justifies it.

Preserve algorithm meaning when optimizing. An MST over an approximate neighbour graph is not guaranteed to be the exact MST over all admitted objects' embedding distances. Keep exactness where promised; any approximate mode must be named, versioned and evaluated explicitly. Drawing fewer edges is different from discarding relationships used for geometry. Visual aggregation is different from a recipe producing deduplicated objects with evidence.

Establish a benchmark ladder at the default budgets and, for example, 300, 500 and 1,000 nodes with sparse and dense relationships. These are measurement targets, not claims of initial support or instructions to raise every project's default. Record the measured performance envelope and bottlenecks, then increase defaults when supported. Both layout limits and recipe throughput must be adjustable without changing object schemas or renderer contracts.

## Objects, revisions and relationships

An object has a stable project-scoped identity and type. A revision is an immutable statement of its content and evidence at a particular time. A run is an execution that produces revisions. A recipe version identifies how they were produced. A Map snapshot selects exact revisions for display. These are separate concepts.

Common envelope:

```ts
type ObjectRevision = {
  objectId: string;
  revisionId: string;
  projectId: string;
  type: string;                 // registered, namespaced for extensions
  schemaVersion: number;
  payload: unknown;             // validated against this type's schema
  attributes: {
    valence?: "positive" | "negative" | "neutral";
    epistemicKind?: "argument" | "claim";
  };
  provenance: {
    runId: string;
    origin: "generated" | "authored" | "imported";
    recipeId?: string;          // required for generated output
    recipeVersion?: string;
    inputRevisionIds: string[];
    sourceRefs: SourceRef[];     // conversation, source fingerprint, quote/location
  };
  createdAt: string;
  actorId?: string;
  parentRevisionId?: string;
};
```

Keep payloads specific: an argument has a complete statement; Popcorn has a short phrase; a tension has poles, narrative and resolution question; a stakeholder has name, role, stake, evidence rung and weights. Do not impose argument fields, valence or embeddings on every type. Current `kind=claim` becomes `type=argument, epistemicKind=claim`; it remains individually fact-checkable.

Relationships connect exact object revisions, carry a registered relation type and evidence, and are immutable within a published output. Initial relations include `supports_pole_a`, `supports_pole_b` from arguments to tensions, and evidenced stakeholder-to-argument/tension relations such as `holds_position` or `affected_by`. Preserve existing stakeholder-to-stakeholder relations and their attributes. Record whether a relation is extracted, inferred or explicitly authored. Do not infer support, attribution or opposition from embedding distance alone.

An unchanged generated object can be reused across runs. Explicit edits append a revision to the same identity using an expected-current-revision check; record actor, reason and before/after through the shared mutation path. Rollback creates a new revision referencing the older content. Generated replacement must not silently overwrite an authored revision. Full inline editing and suggested-change UX are deferred; this storage contract must support them.

Content hashes identify reusable computation, not enduring identity. Producers provide source/lineage keys. Retain an identity only when continuity is known; a rewritten extraction with uncertain continuity creates a new identity. Splits/merges record lineage explicitly rather than guessing from semantic similarity. Removed objects leave current membership but remain available in historical revisions, subject to project/source deletion rules.

Use UUIDs for object and revision identity. Keep content hashes separately and define their canonicalization/version explicitly. An unchanged revision may belong to several result sets, but identical text across unrelated objects does not merge their identity. A regenerated revision may update an established lineage only through the producer's explicit identity policy. A deduplication merge creates its own object and `derived_from` relations; a subsequent split produces new objects with recorded lineage. Never ask a language model to guess database identity.

Source references identify the conversation and source version, with the checked quote and location where available. Preserve enough permitted source material to inspect the original evidence when transcripts later change; do not resolve old evidence against today's text without disclosing the substitution. Source deletion/access rules override historical availability. An unavailable historical source is shown as unavailable, not silently replaced.

Use one revision-writing service for generated, authored and imported changes. Editing supplies `expectedRevisionId`; conflicting writes return a conflict with the current revision rather than using last-write-wins. A generated update that conflicts with an authored head stays a candidate requiring review. The previous ready output remains current. This supports editing in any authorized surface without copying editing logic into every view.

## One execution method, multiple recipes

Introduce a small code-owned registry under a shared analysis package, proposed `dembrane.analysis`, for the initial built-in recipes. A recipe declares its ID/version, human-readable name and purpose, accepted input types, ordered analysis/check steps, output schemas, dependency resolver, execution function, validation/grounding rules, identity policy and optional embedding-text projection. Expose this metadata to support the intended Recipes tab and guided authoring flow. Recipes may use several model calls or deterministic transformations. Unknown recipe IDs and invalid inputs fail before dispatch. Code-owned registration is the first implementation, not a permanent restriction against host-authored recipes.

The entry point accepts `project_id`, `recipe_id`, producer scope, selected source/object revisions, parameters, `mode` and an idempotency key. It checks access, resolves dependencies, pins inputs, queues work through Echo's existing execution facilities, validates outputs, persists revisions/relations and publishes completion. Reuse `live_events`, the ticks worker, LiteLLM, embedding identity/cache and the Map attempt lease approach. Do not build another scheduler or an arbitrary workflow designer.

The mode has an explicit contract:

| Mode | Behavior |
|---|---|
| Refresh | Resolve current requested inputs, reuse completed valid stages, and compute missing/invalidated work. If everything is valid, return the existing ready output with a recorded reuse outcome. |
| Regenerate | Create a new generation epoch for the selected recipe's model stages even if inputs are unchanged. Reuse pinned upstream outputs unless their regeneration was explicitly requested. Identical embedding inputs may still reuse vectors. |
| Retry | Resume the same failed execution's saved work under a new lease. Do not behave like an intentional regenerate. |

Repeated transport requests with the same idempotency key return the same run in every mode. A deliberate later regenerate has a new key/epoch. Cache identity includes source/object revisions, context and sensitivity instructions, parameters, step/prompt/check versions, model/deployment configuration and the generation epoch where applicable. Save actual model outputs and validation outcomes as step artifacts; replay uses those artifacts rather than recalling the model. Keep participant-derived artifacts within the same project access and retention rules, not unrestricted logs.

Resolve recipe dependencies as an acyclic execution plan. Reject a cycle with its dependency path before calling a model. Argument/tension/stakeholder relationships may contain cycles; those are content relationships, not execution dependencies. A parent waiting for a dependency holds no worker slot or database lock. Once the dependency completes, pin that exact output manifest before executing the consuming step. Share compatible in-flight dependency work across parents.

Deduplicate equivalent refresh work by project, recipe version, parameters and input fingerprint. Coordinate active attempts by producer scope, not by project alone: unrelated producers can run independently. Serialize competing publications within one scope, and persist request order so completion order cannot promote an older request over a newer ready one. Keep per-stage progress and resumable outputs; never hold SQL transactions during model calls. Failure leaves the previous ready output intact and does not erase other types.

Each recipe output is a complete declared scope, such as one conversation's Popcorn objects or the project's tensions. Replacing one scope cannot remove another conversation's objects. Later upstream changes mark dependent output stale, showing “Based on an earlier analysis”; they do not silently rewrite it. Initial refresh is manual, with dependency refresh available in the same flow. Existing Popcorn live cadence continues to call its producer through the shared path. No automatic cascade of every derived recipe is introduced.

## Atomic publication and durable notification

Use the existing worker infrastructure with durable run/step state. Lifecycle states are queued, waiting for inputs, running, needs review, ready, failed, cancelled and superseded; extraction/embedding/verification are progress stages, not new lifecycle states for every recipe. A crashed worker can resume only under a renewed lease. Every checkpoint and publication verifies that lease. Cancelled or superseded workers cannot advance heads even if a model call returns later.

1. Persist candidate objects/revisions, step artifacts and embeddings as work completes. They are visible through authorized run inspection, but not through published-object or map queries.
2. Before publication, check schemas, source/relationship validity, required checks, vector durability and authored-revision conflicts. Hard validation failures cannot be published. Reviewable results stay `needs_review`; existing ready output remains visible.
3. In one short PostgreSQL transaction, lock the producer scope, recheck lease/request order/expected heads, finalize the immutable output manifest, mark the run ready, advance permitted current references and append a publication event to a durable outbox. Roll back the entire operation on failure. No model or webhook call occurs inside the transaction.
4. An outbox dispatcher retries committed events through the existing workers. Consumers use event IDs and snapshot/result IDs to handle duplicates. Persist delivery attempts and outcomes. Failed notification does not undo a valid result.

The outbox guarantees that a committed publication is available for later dispatch. Redis/SSE remains a notification transport, not the durable record or dependency executor. Clients load authoritative snapshots on connect/reconnect and recover revision gaps using a publication sequence; a delivered server notification does not prove every browser received it. Dependency scheduling consumes durable completion state. Future webhooks use this same publication boundary with explicit authorized subscriptions and destination idempotency.

Guarantee idempotent publication and retryable dispatch, not exactly-once external model execution. A crash after a provider responds but before its output is saved can incur a repeated call; checkpoint completed artifacts and surface actual usage rather than claiming that cannot happen.

## Producers in this change

| Producer | Inputs and responsibility |
|---|---|
| Arguments | Current Map's grounded transcript extraction, preserving complete statements and the argument/claim distinction. Remove duplicate observations of the same source item across overlapping windows, but preserve distinct extracted arguments as source objects for explicit deduplication. |
| Deduplicated arguments | Pinned argument revisions. Produce separately identified, grounded arguments that consolidate equivalent source arguments and retain them as evidence. Reuse the current consolidation work inside this explicit recipe, with semantic verification as described below. |
| Popcorn | Existing transcript-to-short-phrase recipe and voice configuration. Publish its output to the shared store; do not generate different popcorn for Map. |
| Tensions | Pinned raw or deduplicated argument revisions plus their source passages and necessary transcript context. Record which set is used; generate both poles and link supporting argument revisions explicitly. |
| Stakeholders | Existing grounded stakeholder recipe, with pinned arguments/tensions available for relationship extraction. Preserve voiced/named/inferred distinctions; absence from the corpus is not evidence of a position. |

Arguments feed tensions as a data dependency, not through a mounted tab. Replace the tension pipeline's independent position-extraction stage with the saved arguments. Retain its useful framing, collision, verification, deduplication and writing checks where compatible with this input. The final output must contain evidence-backed arguments on both poles; it may retrieve source context to verify meaning but must not invent a side or secretly rerun an unrelated full argument extractor. If the arguments lack needed coverage, report that and offer to refresh them. Zero supported tensions is a valid result.

The Tensions tab and Map consume the same tension revisions through their presentation adapters. Keep today's `poleA`, `poleB`, `narrative`, `toResolve` and quote contract for the deck. The Popcorn and Stakeholders tabs likewise project shared outputs. During migration only one producer is authoritative per scope; avoid both the old tick and the new executor generating competing versions.

## Deduplication produces objects with evidence

The dependency can be `Arguments → Deduplicated arguments → Tensions`. Running tensions on raw arguments is also valid. Input selection pins one intended argument set; do not automatically count both a consolidated argument and all its members as independent inputs.

Register `deduplicated_argument` as an output type with the same complete-statement and epistemic fields needed by argument views, plus `derived_from` relations to every contributing original argument revision. Its evidence is those original arguments, with their transcript evidence available through the lineage. Originals remain unchanged and available for inspection or mapping. A singleton can pass through as one output with one source reference, so the recipe accounts for its whole input set.

Embedding similarity proposes candidates; it does not establish equivalence. Verify that consolidation preserves the position, reasoning, qualifications and meaning. Do not merge opposing positions merely because they discuss the same topic, flatten incompatible valences, or turn several claims into a broader unsupported claim. Preserve minority and unique arguments. Record input membership and verification outcomes on each result. A support count describes source arguments; participant/conversation counts must be deduplicated separately if shown.

Verification applies to the final consolidated statement against every member, not just to neighbouring pairs. A≈B and B≈C is insufficient to merge A, B and C. Preserve distinctions in population, conditions, time, certainty and explicit stance. Uncertain groups remain separate; model verification is recorded and evaluated, not treated as infallible. Keep a regression corpus of duplicates, near-duplicates, qualified statements, conflicting positions and minority arguments. Assess false merges separately from missed duplicates, with false merges the more serious failure. The inspector exposes members and verification rationale so the transformation is reversible by selecting its original inputs.

The recipe aims to remove duplication, not to hit a node quota. If 230 arguments are genuinely distinct, returning 230 is correct; the host can increase the map budget or choose a narrower scope. A later thematic grouping or summarization recipe would be a different, explicitly named transformation. Do not conceal that transformation inside deduplication.

Embed each final statement, reusing its vector only when text and configuration match. A deduplicated claim does not inherit a source's fact-check verdict automatically; it is checked against its own statement and resolved evidence. Changed source revisions make a saved deduplication result stale rather than changing its membership or wording in place. Reruns preserve prior results and their lineage.

The current Map recipe already consolidates extracted candidates before publication. Move that responsibility into the explicit deduplication recipe for new outputs. For migration, mark existing consolidated objects with their legacy recipe provenance; reconstruct source objects only from saved candidates/evidence that actually exist. Never fabricate missing pre-consolidation arguments.

## Mixed graphs, attributes and titles

Every map-capable type provides label/detail projection and embedding text. Embed argument statements, popcorn phrases, tension poles plus narrative, and stakeholder name/role/stake. Use the existing `map_embedding` cache with project, exact input hash and configuration key. A mixed graph uses one embedding configuration; compute missing vectors for that configuration without rerunning extraction. Preserve prior configurations for historical results. Relationships do not require embeddings.

Version the embedding-text projection and evaluate mixed-type neighbours on real project fixtures. One embedding model/configuration is necessary for comparison but does not establish that short phrases, full arguments and stakeholder descriptions form useful semantic neighbourhoods. Check for clustering driven mainly by format and preserve the relationship view as a separate interpretation. Any projection change creates new cache inputs/configuration and never rewrites historical vectors.

Do not consolidate across object types: a short popcorn excerpt and an argument may express the same idea and share evidence while remaining different objects. Reusing an identical embedding does not merge their identities. Counts describe visible objects, not independent participants or independent support.

Preserve the two existing geometry algorithms over the filtered, placeable node set. Filtering changes that set, so recompute its MST and local neighbourhoods while retaining positions/zoom for surviving nodes. A filtered MST is a new proximity tree, not evidence that objects acquired new relationships. Keep explicit relation overlays out of MST construction, local-neighbour forces, centrality and Showcase walk traversal. Missing vectors produce listed unplaced objects, not disappearing content or fabricated coordinates.

Move style selection to attribute definitions: attribute ID, category or numeric value type, applicable object types, value accessor, missing-value behavior, palette and legend. Ship Type, Valence and Factual status; no arbitrary expression editor is required. Categorical values use discrete colors; any later numeric attribute uses a declared scale. Missing valence is “Not assessed”, distinct from neutral. Factual status distinguishes not applicable, unverified, processing, completed verdict and error; a stakeholder or tension does not inherit the verdict of a connected claim. Keep state labels inspectable as well as color-coded.

Both renderers consume the same style resolver. Color, verdict and label updates must not reconstruct geometry or reset selection. Size changes may update collision geometry in place. Keep current highlighting visually independent of color mode.

Use an explicit layout boundary: a graph projection supplies identified object revisions, validated vectors, typed relationships and style attributes; a cancellable layout worker returns positions/geometry for a request ID and algorithm version. Rendering and interaction consume that geometry. Responses for older request IDs are ignored. Preserve the previous positions, zoom and selection for surviving nodes while recomputing. Version random seeds/parameters so a regression fixture is repeatable. A framework or library change must preserve this contract.

Semantic MST/local-map layouts continue to use embedding distance. A future stress-based Relationships layout uses explicit relation topology and readable geometry. Every map-capable object can participate in either; color remains independent of layout. Recipe execution dependencies can be inspected as provenance, but are not silently mixed into semantic distance or content relations. The Relationships solver itself remains a follow-on experiment with benchmarks, not a requirement to replace the two delivered layouts.

Generalize selection titles to typed revisions: include each item's type and relevant text, plus explicit relations inside the selection. Avoid counting a tension and its supporting arguments as independent corroboration. Resolve the complete authorized selection on the server; preserve minimum selection size, context limits and late-response protection. Key caches by the exact snapshot/revisions, selected IDs, prompt/model and relevant fact-check revisions. Hiding nodes cancels an obsolete pending selection; history retains its original revision references without silently substituting current text.

Fact-check eligibility is an explicit capability. Initially it remains limited to claim-classified raw or deduplicated argument objects. Keep PR #1074's bounded queue and cancellation protections. Changed statement or evidence invalidates the old check. Retain completed attempts as revisioned annotations using the common object path; `map_fact_check` may continue as the operational current-state table. Do not introduce a second model pipeline for fact-checks. A re-check appends an assessment instead of erasing the old one. Translations, when implemented, similarly reference exact source revisions and do not replace their source text or automatically inherit a verdict.

## Coherent snapshots and historical reconstruction

Every view reads one immutable snapshot manifest. It pins output sets, displayed object revisions, relationship IDs, relevant assessment/translation/title revisions, embedding configuration and view/schema/renderer versions plus saved presentation settings. Do not independently fetch the latest result of each type during rendering. Otherwise a page can claim a relationship that was established against different text.

Snapshot construction resolves the requested producer outputs once, validates reference compatibility, and records the result atomically. If a tension references an older argument than the selected argument output, retain that provenance and flag the tension as stale. Do not draw its historical support edge to the newer revision. The host may refresh the dependent recipe or inspect the historical source. Unrelated recipe outputs need not share an execution time, but their sources and freshness must remain explicit.

A live/current view follows completed snapshots. A pinned view remains on its selected snapshot until explicitly changed. A completed fact-check can create a successor snapshot for a following view without moving graph nodes; it does not mutate an old snapshot. Retain historical recipe/view artifacts or immutable references needed to reconstruct content and settings. Exact animation-frame replay is not required.

The audit inspection must answer “What content and assessments were shared?” and “Which original evidence supported this tension?” from saved manifests and revisions. Use ordinary PostgreSQL revision rows and current pointers; an event log is supplementary. Existing legacy snapshots without historical assessments remain labelled incomplete rather than filled with today's verdicts. Public access is always checked against current sharing policy even when the content snapshot is historical.

## Persistence and migration

Use Directus-managed collections for the following responsibilities. PostgreSQL remains the authoritative store; Redis coordinates/notifies and never holds the only copy of an output.

| Collection | Required responsibility |
|---|---|
| `analysis_scope` | Project, producer and configured input scope identity, next request order, current ready run and expected publication generation. Provides the row locked during publication. |
| `analysis_run` | Recipe/version, immutable step/check definition references, mode/epoch, input manifest/fingerprint, parameters/context versions, progress, lease, request order, status and immutable completed output manifest. |
| `analysis_step` | Per-run step identity and cache fingerprint, attempt/lease, checkpoint, actual model or deterministic output, validation results, usage and completion state. Saves resumable work and resolves reused artifacts without copying every payload. |
| `analysis_object` | Project, type, producer identity/lineage key and current revision pointer. The pointer is a discovery/edit head, not the source for historical views. |
| `analysis_object_revision` | Schema version, validated payload, attributes, evidence/provenance, parent, author/time, content fingerprint and embedding references. Immutable when published. |
| `analysis_relation` | Project-scoped typed endpoints pinned to exact revisions, supporting provenance and attributes. Published relations are append-only; output manifests define membership. |
| `analysis_snapshot` | Immutable view manifest with pinned output, object, relationship and annotation references, versions/settings and a parent snapshot where applicable. Canonical source for rendering/export selection. |
| `analysis_outbox` | Unique publication event ID, project/scope and sequence, result/snapshot reference, dispatch state and retry metadata. Inserted in the publication transaction. |

These tables have distinct consistency responsibilities; they do not require separate services. Keep them behind the shared analysis package and use existing database/runtime helpers. Persisting host-authored recipe definitions and destination bindings will extend this foundation later. Initial registry definitions and configured parameters are captured immutably with each run; do not overload output objects with recipe configuration.

Use foreign keys and unique keys for `(project, idempotency_key)`, `(scope, request_order)`, `(run, step_key)` and `(object, revision_number)`. Reused step artifacts must belong to the same permitted project/cache scope and compatible configuration. Lock/check the scope and lease for publication and use expected revision heads for edits. Validate that endpoint, parent, embedding and input references belong to the same project, including SQL-level safeguards where practical. Snapshot JSON reference validation is mandatory within publication; merely storing IDs in JSON is insufficient. The audit log records actions; it is not the only place to reconstruct content history.

Keep `map_result` as a compatibility record: legacy v1 manifests remain readable, and new v2 records reference the canonical `analysis_snapshot` rather than owning a second mutable manifest. The adapter preserves existing result URLs and maps legacy node references to object revisions. Snapshot assembly and current-view advancement are a short transaction with an expected previous snapshot; an older assembly job cannot overwrite a newer view. A single snapshot includes at most one displayed revision per identity; relationships to older revisions remain historical references in the inspector, not lines to newer text.

Staging rows are excluded from normal output queries until their run is ready. Failed-run inspection may read its candidates explicitly. Garbage collection can remove abandoned staging work only after it is unreferenced and beyond the configured recovery period; never prune shared step artifacts or embeddings still referenced by published history. Follow existing deletion policy for the project and its sources.

Reuse `map_embedding` physically through a shared service; renaming the table is unnecessary. Do not regenerate valid stored vectors for a package rename. Retain vectors referenced by old results/revisions. Existing deletion/access behavior must also apply to new collections; retained history does not restore access to deleted sources. Do not add a new retention policy as a side effect.

Implementation order:

1. Follow Echo's Directus REST migration and generated-snapshot workflow in `echo/AGENTS.md`; put SQL-only constraints/indexes in an executable, idempotent migration as with `add_map_vectors.sql`. Preserve pgvector and its checks. Verify fresh installation and second application locally.
2. Backfill Map manifests into object/revision records without model calls. Keep a deterministic mapping from legacy result/node IDs to revision IDs. Reuse identity only for known legacy lineage; identical full content/evidence can share a revision. Preserve old result endpoints and historical manifests.
3. Import existing Popcorn/tension/stakeholder outputs with their real source scope and snapshot identity. IDs such as `x1` and `s1` are positional, not durable identities. Do not merge unrelated historical items by ID. Preserve legacy provenance and existing public links. Import only saved history; record missing historical provenance explicitly instead of inventing it. Imported tensions have no argument relationships unless these can be grounded; mark them legacy and offer regeneration through the new recipe.
4. Route new writes through the shared executor, with legacy entry points delegating to it. Serve legacy deck shapes from adapters. Record writer ownership per producer scope and fence/drain in-flight legacy generation before transferring ownership; retries must not double-publish. Never dual-run the old and new producers as competing authorities. Keep an import watermark/uniqueness key so repeat backfills are harmless.
5. Add the v2 Map payload and migrate frontend adapters/settings. Keep existing `none`, `valence`, `factCheck` saved preferences working. Verify Directus snapshot round trips retain SQL-only columns and indexes.

Rollback keeps additive schema and legacy results and routes application use to the old readers where possible; never drop vectors/history. Stop/fence new producers before reversing writer ownership. New v2-only data remains retained even if the old app cannot display it. Deliver the migration sequence and compatibility checks with the implementation; run locally first.

## Integration-shaped outputs

Prove extensibility with a registered fixture recipe that transforms selected object revisions into a schema-validated external-API-shaped payload. It uses the same run, provenance and revision storage, and can be inspected as JSON. It has no graph projection or embedding unless useful. This establishes the extension point without requiring a real integration or another generic UI.

A later real integration supplies its destination schema/version and mapper or recipe. Generating a payload and delivering it are separate actions: no network write occurs during generation. Delivery will need its own authorization, destination, idempotency and receipt referencing the exact payload revision. No connector, credentials UI or external write is included here.

## Intended custom recipe and view authoring

A host should eventually be able to describe the result or presentation they want and work through the prompts with a language model. The guided flow develops a recipe, a JSON data contract and, where wanted, an HTML view that renders that contract. Dembrane handles the data generation/export binding rather than requiring the host to build their own backend.

The intended loop is: describe the outcome → draft ordered analysis and checking steps → define/example the JSON output → generate an HTML view or export mapping → preview against fixture and selected project data → inspect checks and refine prompts → save versioned recipe/view definitions and connect the destination. A host can create an export without a view, or create a view over existing compatible objects without regenerating them.

Version the recipe, data schema and view independently, recording their compatibility and the exact versions used in each preview or published output. Generated HTML consumes a documented JSON contract in an isolated rendering environment; it does not receive application credentials or unrestricted access to other project data. Validate outputs before rendering/export and keep authoring preview separate from public sharing or delivery. Views are presentation code; model calls and connector execution remain in the shared services.

This guided authoring experience is an explicit follow-on intention. The current code registry and fixture integration recipe prove its underlying contract; building a general visual workflow editor or the complete HTML authoring interface is not required for the mixed-map implementation.

## Implementation boundaries and acceptance

Add the shared analysis package by extracting existing execution/storage responsibilities, keeping Map/Popcorn compatibility entry points thin. Primary frontend changes are `types.ts`, `data/adapter.ts`, hooks, settings/legend/detail panels and shared styling. The renderers need per-node size and relationship-overlay inputs, not new layout algorithms. Migrate existing argument tests alongside the refactor; do not rely only on newly written happy-path tests.

Build the first complete path as `Arguments → Deduplicated arguments → Tensions → one pinned snapshot`, consumed by Map and the existing tension presentation adapter. Prove its failure behavior before moving the remaining Popcorn/Stakeholder producers over. This is the first implementation milestone, not a substitute for the complete scope below. No extra design-document approval cycle is required.

- Within the new rendering budgets, legacy arguments retain PR #1074's appearance, linked interactions and fact-check behavior. Oversized legacy results remain inspectable and can be scoped without regeneration.
- A fixture and a real local project show raw/deduplicated arguments, Popcorn, Tensions and Stakeholders in both renderers within the shared node cap. Type filters and color modes make no generation requests; geometry does not restart for color/verdict updates. Filtering, hidden related nodes, missing embeddings and type-based sizes work consistently.
- Every generated tension links to exact arguments on both poles with inspectable source evidence. Replacing an argument revision makes the dependent tension stale without rewriting history. The deck and Map show the same selected tension revision.
- Popcorn appears from the same producer output as its presentation screen; generation from either entry point deduplicates. Its short-form constraints do not change the argument recipe.
- Retry, concurrent refresh, stale worker, invalid schema/reference and database failure tests verify atomic publication and unchanged prior ready outputs. One producer's failure cannot remove another type.
- Revisions reconstruct prior content and dependencies; an edit conflicts rather than overwriting a newer head. Reworded claims do not inherit verdicts. Fact-check updates, relation references and title history respect revision identity and project access.
- Fresh/upgrade/backfill/second-run migrations preserve existing vectors, Map results, Popcorn history and public links. Unchanged inputs/configurations reuse embeddings; incompatible vectors are never compared.
- The fixture integration type is added through schema/recipe registration without editing execution internals or graph algorithms. Inspecting its payload causes no external write.
- Recipe metadata exposes ordered steps, output schemas and checks, and executions retain check outcomes and version references. Future Recipes-tab controls can call the same services as existing contextual entry points.
- Parameterize budget tests around `nodeLimit - 1`, `nodeLimit` and `nodeLimit + 1`, including default and raised settings, plus empty/single-node and small-result states. An over-budget scope must not start layout or fetch its full vector set; raising the budget admits it without regenerating data. Changing settings persists across reloads, and frontend/backend limits agree.
- Dense-relationship fixtures never draw more than the configured `edgeLimit` and always retain the MST's N−1 edges. Reject inconsistent budget pairs. Edge counts disclose omitted lines, selection prioritizes relevant relations, and detail inspection can reach every relation.
- Deduplication retains original argument revisions, accounts for every input and preserves minority/opposing positions. An output above the current display budget remains valid without further forced merging. Derived evidence expands to original arguments and transcript sources; changed inputs invalidate freshness and do not rewrite history.
- Demonstrate recipe-stage reuse, bounded execution concurrency and cancellation without lost checkpoints. Compare graph computation against exact small fixtures, verify stale worker results are ignored, and record visualization/recipe benchmarks independently at the default and higher test budgets. Larger test budgets are not automatically enabled as defaults.

Required failure/reconstruction scenarios:

| Scenario | Required result |
|---|---|
| Repeat Refresh with unchanged inputs | Existing valid artifacts/output reused; no new model calls required. |
| Repeat transport request for Regenerate | Same run returned. A new deliberate regenerate creates a new epoch and model attempt, with reusable identical embeddings. |
| Crash after saved extraction or embedding | Retry resumes saved stages under a new lease. The former worker cannot publish. |
| Crash during publication | All output/head/outbox changes commit together or none do; prior ready output remains usable. |
| Crash after commit, before notification | Outbox dispatch later retries. Duplicate dispatch does not rerun dependent work or duplicate publication. |
| Dependency changes while tensions are running | Completed tensions retain their pinned inputs and are marked stale as appropriate. Historical links never retarget automatically. |
| Two publications or an edit race for one scope/object | Lease, order and expected-head checks prevent an older or conflicting write from silently winning. |
| Re-check a claim after a snapshot was shared | Following views may advance to a successor snapshot. The shared historical snapshot still resolves its original assessment. |
| Similarity chain A≈B≈C with meaningfully different A/C | The combined merge fails verification; original distinctions and evidence remain accessible. |
| Hidden type or raised rendering budget | Only projection/layout changes. No extraction, deduplication or external delivery starts implicitly. |
| Source becomes unavailable | Historical inspection respects current access/deletion policy and marks missing evidence; it never substitutes another source. |

Deliver a traceable example with the saved snapshot ID, tension revision, supporting deduplicated/raw argument revisions, source references, recipe/check versions and assessment records. That example must be inspectable after restarting API/workers and without replaying model calls. Record remaining integration limits explicitly rather than declaring mocked providers or unexecuted migrations complete.

Design references: [Build Systems à la Carte](https://www.microsoft.com/en-us/research/publication/build-systems-a-la-carte/) informs dependency tracking and artifact reuse; [PostgreSQL transactions](https://www.postgresql.org/docs/current/tutorial-transactions.html) provide the atomic publication primitive. These are design references, not additional frameworks to install.

Deferred from this implementation slice, while explicitly part of the product direction above: the Recipes tab UI, guided custom recipe/HTML-view authoring, real webhook/connector delivery, full editing/suggestion UI, the Prepare/Present/Analyse navigation restructure and new presenter-mode designs. A universal workflow engine is not a prerequisite for any of them. The mixed-map implementation should proceed from this spec, resolving routine code choices against the PR baseline and recording any material deviations for local review.
