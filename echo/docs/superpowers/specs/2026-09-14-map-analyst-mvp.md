# Map: bring the DDW map experience into Echo

Status: local implementation handoff. This task prepares the spec only. Implementation includes the migrations, embedding execution, storage, frontend port and verification below. Build and review locally, with one PR after the host is happy; do not push or deploy as part of the local implementation.

## Intent

An analyst opens Map to explore the arguments in a project's conversations: understand related positions, inspect their evidence, find central arguments, and make sense of a selected group.

The DDW map frontend is the design baseline to preserve, not inspiration for a newly designed MVP. Its visual treatment and existing map interactions are close to the intended release experience. Port and repair that frontend; rewrite the surrounding application scaffolding for Echo. Architectural separation must not become an excuse to simplify away its affordances.

Map owns its recipe because this experience needs complete arguments. Popcorn owns a different recipe because its excerpts must be immediately legible on a presentation screen. Shared infrastructure supports both. Neither recipe has to become a universal analysis model.

This proposal replaces the Popcorn-dependent starting point in the earlier Map spec for this slice. It does not depend on the proposed Analysis/Library restructure.

## Preserve the map, replace the scaffolding

Preserve the DDW map's layout and motion, navigation, selection and highlighting, inspection panels, map controls, selection-title interaction and history, and fact-checking. The MST and local map are linked renderers within one analyst experience, not independent features or alternative ports. Both are in scope. Existing behavior is the baseline; this document's examples are not an exhaustive replacement specification. Keep the map's useful visual design while integrating its surrounding controls, typography and application chrome with Echo.

Both renderers use the same item identities, selected node, highlighted group and fact-check results. Preserve cross-highlighting and shared inspection/title behavior when interacting with either renderer. Preserve DDW's distinction between preview and settled selection, including the source of an interaction, so one renderer does not clear the other's selection or trigger a duplicate title request. Their graph geometry remains distinct.

Replace DDW's standalone setup, credentials, project loading, browser model calls, application persistence and extraction/reconciliation engine. Use Echo's navigation, authorization, server-side services, execution/progress and data lifecycle. Local interaction state can remain in the frontend; generated data and execution state must not depend on DDW's browser stores.

Before porting, walk through the DDW frontend and capture a short behavior checklist with representative data. Record observed bugs separately from intentional behavior. Verify the port against that baseline and fix reproduced bugs; no particular bug is claimed as confirmed by this spec. If an existing map affordance needs an unavailable backend capability, identify that dependency explicitly rather than silently removing the affordance or importing DDW's backend architecture.

## Echo entry and data lifecycle

1. Open a project and choose Map in the sidebar. It is available to every project, subject to existing project permissions.
2. Choose “Generate map”. The first version uses the project's available transcripts and shows generation progress here. No Popcorn session or separate Analysis visit is required.
3. Explore and inspect the result using the existing DDW map experience, including its summarizing cursor. Adapt source links to Echo conversations. Do not replace the interaction model with a new list-and-detail design.
4. Return to the saved result later, or choose “Regenerate” from Map. Regeneration creates a new result revision. Keep the previous result visible until the replacement is ready; a failed attempt does not destroy it.

Proposed initial scaffolding: one current map per project and manual generation. These limits do not reduce the map's existing frontend affordances. The working scale is approximately 50–200 arguments. This is a validation target, not an extraction quota: do not invent arguments to reach it or silently discard results to fit it. Smaller results remain usable.

## Map's recipe

Read transcripts → extract distinct, source-grounded arguments → consolidate equivalent statements while retaining their evidence → embed the complete statements → build the tree.

This describes the required output, not adoption of DDW's extraction or reconciliation engine. Implement the recipe through Echo's services; review existing Echo argument work for reuse. Do not transplant DDW's reinforce/modify/retire lifecycle or browser orchestration as the new execution model.

An argument must stand on its own and preserve the position, relevant reasoning and qualifications supported by the transcript. Prefer concise sentences, but impose no Popcorn word limit. Do not invent missing reasoning. A short display label may accompany the full statement; it does not replace the text used for embeddings or inspection. Preserve disagreement when consolidating similar material. Retain DDW's distinction between arguments and externally checkable claims so fact-checking applies to eligible claims.

Each saved result records its source revision/fingerprint, recipe version, embedding model and argument identities with source references. Only combine vectors from the same embedding configuration. Reuse unchanged embeddings where that configuration matches.

## Boundaries to implement

| Responsibility | Boundary |
|---|---|
| Map recipe | Owns extraction instructions, consolidation policy and generated argument data. Runs without a mounted Map screen. |
| Graph computation | Accepts identified vectors; computes the MST and the local map's own neighbourhood representation, preserving DDW's respective algorithms. No transcript fetching, prompts or Popcorn state. |
| MST and local map renderers | Consume the same identified data and shared interaction state, with their respective graph representations; emit node/selection events. Own layout, pan, zoom and highlighting. No generation, scheduling or data fetching. |
| Shared map interaction state | Coordinates selected/highlighted IDs, preview versus settled selection, interaction source and inspection across both renderers. Does not own extraction or model execution. |
| Selection title operation | Accepts an authorized result revision and selected item IDs; resolves their text and returns a title for that selection. No cursor coordinates or renderer state. |
| Fact-check operation | Accepts an authorized claim revision, resolves its statement, evidence and project context, investigates with web grounding and classifies the result. Returns status, verdict, justification and source links to both renderers and their shared panels. Uses Echo's server-side model and execution services. |
| Map page | Connects those capabilities and provides the analyst's controls, evidence panel and progress. |

Use Echo's existing model routing, execution/progress, persistence, access checks and applicable audit facilities. Do not copy DDW's browser model access or create a Map-specific scheduler. Integration with a future temporal execution layer belongs at the execution boundary; building that layer is not a prerequisite here.

These boundaries allow another compatible dataset to reach the renderer later. No generic dataset picker, adapter registry or universal run schema is needed now.

## Embedding execution and durable storage

Embeddings are a required persisted output. Echo already has `echo/server/dembrane/embedding.py::embed_text`, using LiteLLM and `settings.embedding`. Extend/reuse that service rather than introducing DDW's browser provider client. What is new here is the Map embedding stage and its durable lifecycle.

At implementation startup, verify the configured embedding provider/model and returned dimensions with one small request. The inspected helper declares `EMBEDDING_DIM = 3072`, while settings default to `text-embedding-3-small`; do not infer actual dimensions from that constant. Record the resolved model/deployment identity, dimensions and input/task configuration as an embedding configuration key. Use the existing deployment configuration; do not silently switch models or mix fallback embedding spaces.

The worker extracts and persists candidate arguments, loads reusable embeddings, embeds only missing or changed text, validates finite nonzero vectors of the expected dimension, persists them, then marks the result ready. Embed the full statement actually attached to the node. If consolidation rewrites that statement, embed the final text. A title, hover, graph layout or page reload must not rerun extraction or embedding.

Use bounded concurrency, existing retry/backoff and execution/progress facilities, and per-project generation coordination. Show extraction and embedding progress separately. Persist completed embedding writes incrementally so a retried job resumes from saved work. Do not hold a database transaction open during a model call. An upsert prevents duplicate rows; execution coordination also prevents both linked renderers or duplicate jobs from generating the same vectors concurrently. Log execution outcome, configuration, counts, cache reuse and usage where supplied by the provider, without logging transcript bodies or credentials.

Minimum storage contract, using Map-owned Directus collections rather than a new universal schema:

| Record | Required contents |
|---|---|
| `map_result` | Project relation, execution reference, status, source fingerprint, recipe version, embedding configuration, creation/completion times, and a persisted argument manifest containing IDs, full statements, kinds, source references and embedding references. Store each generated result as a revision. |
| `map_embedding` | UUID, project relation, hash of the exact normalized embedding input, embedding configuration key, model identity, dimensions, creation time, and a PostgreSQL `embedding vector` column. Unique key: project + input hash + configuration key. |

Use non-null vectors with a dimension check against the recorded dimensions. An unconstrained `vector` type allows separately identified configurations with different dimensions; each graph still uses exactly one configuration. See the [pgvector dimensionality documentation](https://github.com/pgvector/pgvector#can-i-store-vectors-with-different-dimensions-in-the-same-column). No approximate vector index is needed for the initial 50–200-node graph computation. Index project/result lookups and the embedding uniqueness key.

Ready results reference persisted vectors, not a best-effort cache. Database write failure fails the attempt visibly and leaves the previous ready revision current. Publish a new current revision atomically only after all required data is durable, and prevent an older concurrent attempt from superseding a newer one. Retain vectors referenced by saved results; do not copy the branch store's pruning of everything absent from the latest execution. Project deletion must clean up its results and vectors. Direct SQL reads/writes remain project-scoped behind Echo's access checks.

## Migrations and local verification

Follow [Echo's Directus rules](../../../AGENTS.md), [database migration guide](../../database_migrations.md), and the local [echo-local-dev skill](</Users/jorim/.claude/skills/echo-local-dev/SKILL.md>) section “Schema and the vector extension”. A separately named Directus migration skill was not found in the inspected checkout or skill directories. These verified references provide the implementation workflow; do not claim to have run a missing skill.

1. Inspect the target checkout and local schema before choosing code to reuse. The local `popcorn-arguments` branch contains `echo/directus/migrations/add_popcorn_argument_embedding.py` and `echo/server/dembrane/popcorn/embedding_store.py`; inspect them with `git show`, without assuming they are merged or deployed. Their Popcorn loop ownership, model-overwriting unique key and swallowed database failures do not meet this spec unchanged.
2. Create the collections, regular fields, relations and required access metadata through an idempotent Directus REST migration, following existing scripts in `echo/directus/migrations/`. Verify changes against local Directus. Never hand-write snapshot JSON.
3. Supply a separate, executable, idempotent SQL migration for `CREATE EXTENSION IF NOT EXISTS vector`, the vector column, checks and indexes. The repository's local Postgres image already includes pgvector (`0.8.1-pg16` in the inspected compose file); verify extension availability in the actual database. The existing branch treats vector columns as SQL-only. Merely printing SQL at the end of a script is not a completed migration.
4. Apply the SQL with stop-on-error behavior, inspect the resulting column type and constraints, then pull the Directus snapshot with `sync.sh ... pull`. Include only the intended generated snapshot changes and the repeatable SQL migration in the implementation diff. Prove a subsequent Directus diff/push preserves the SQL-managed vector column and indexes. Respect the documented `is_indexed` exception in `AGENTS.md`.
5. Document one reproducible local setup path: baseline Directus schema → new collection metadata → pgvector SQL → worker/API startup → verification. The local skill's `echo-dev.sh migrate` provides baseline schema and extension setup; it does not substitute for the new column/constraint migration. Read its helper before running it.
6. Test fresh installation, upgrade over existing Echo data, and a second application of each migration. Existing Popcorn data remains intact; no destructive conversion or automatic embedding of all projects is required. Generate Map data explicitly. For rollback, retain the additive schema/data and revert application use; do not drop the shared vector extension. Record the eventual deployment order, but run only locally in this phase.

## Follow-on: Map on display

The same map can support two experiences: an analyst actively explores arguments, while a presenter display guides a room's attention through them. The analyst port remains the first slice. A display mode is a follow-on direction, not a second extraction system or an expansion of this implementation scope.

DDW's display experience, as described by the host, walked through the tree, highlighting arguments and holding them on screen for a while. Preserve the architectural affordance for this: the renderer accepts an externally controlled focus/highlight state, whether driven by analyst interaction or a presentation sequence. Presentation does not require a synthetic hover event, a new dataset or a second graph implementation.

A future Map presentation can reuse the saved argument result and graph, with its own pacing, readable argument treatment, transitions and reduced controls. It should work without someone actively navigating. Random-walk sequencing is a candidate from DDW, not a prescribed final playback algorithm. The linked local map and analyst panels remain part of the analyst experience; their presence on a display is a presentation design choice, not a requirement to show the whole analyst workspace.

DDW also displayed submission progress. That served its event context but is not intrinsic to Map presentation and is not included by default. Popcorn remains a useful presentation choice for short, immediately legible excerpts; Map presentation provides spatial context for full arguments. These experiences may share rendering and focus capabilities without sharing extraction constraints.

## Behavior and integration constraints

- Preserve DDW's cosine-distance MST, radial initial layout and subsequent interaction behavior. Separate graph computation from rendering without changing the intended visual result.
- Preserve the linked local map, including its neighbourhood geometry, controls and synchronization with the MST. Sharing selection does not mean sharing layout coordinates or replacing its graph with the tree.
- DDW's inspected layout finds its centre by minimum eccentricity: the fewest hops to the farthest node. This is not evidence of an existing centrality-sorted list. Centrality ordering remains a requested affordance to check against the frontend baseline, with the smallest addition needed if absent. Do not assume a new metric or redesign the panels in this spec.
- Preserve the settled-selection title flow, including its existing delay, selection feedback and history. The inspected flow uses 1.5 seconds and at least three arguments. Preserve the frontend's title behavior while moving generation to Echo; generated titles remain distinguishable from transcript-grounded arguments.
- Preserve the title prompt's focus on the selected group's theme or disagreement. Selection identity must survive the move from DDW's stores to Echo's data adapter.
- Cache titles by result revision, selected IDs and prompt/model configuration. Ignore late responses for an obsolete selection. A generation failure leaves the selection readable and retryable. Do not silently summarize only part of a selection if it exceeds the supported context size.
- Preserve DDW's fact-check workflow: grounded investigation followed by classification as true, false, contested or unknown, with justification and source links. Preserve manual checks, cancellation, error/retry behavior, verdict coloring and the optional automatic checks enabled by the fact-check color mode and its setting. These are part of the port, not a deferred optional service.
- Move fact-check execution and results out of the browser into Echo. Deduplicate execution across both renderers and associate results with the checked claim revision; a changed claim must not inherit an old verdict as current. Preserve request cancellation semantics so late completions cannot overwrite cancelled or superseded state. An execution failure remains an error, distinct from an unknown verdict.

## Reuse from the inspected code

DDW reference: `/Users/jorim/Dev/ddw/`.

- `src/components/features/ArgumentTree.tsx`: cosine-distance MST, rendering and radius/downstream selection. Its store imports mean it is not yet an independent renderer.
- `src/components/features/LocalMapGraph.tsx` and `src/features/visualizer/components/`: companion graph, panels and map controls to assess and preserve as part of the frontend baseline.
- `src/components/features/graphLayoutUtils.ts`: radial layout and minimum-eccentricity centre.
- `src/features/visualizer/Visualizer.tsx` and `src/features/arguments/useTitleProcessing.ts`: settled selection and title generation.
- `src/stores/visualizerSelection.ts`: shared selection/highlight identities, interaction source and preview state linking the renderers.
- `src/features/visualizer/hooks/useFactCheck.ts`, `useAutoFactCheck.ts` and `src/features/visualizer/nodeStyle.ts`: fact-check semantics, triggers, cancellation and result coloring. Preserve behavior while replacing browser model calls and result storage.
- `src/features/arguments/useArgumentProcessing.ts`: reference for understanding the current data contract only. Its extraction/reconciliation implementation is not the system to port.

Echo's local `popcorn-arguments` branch already contains `echo/server/dembrane/popcorn/arguments.py`, `embedding_store.py` and `prompts/arguments-v1.md`. Reuse the applicable extraction, grounding and embedding work, separating the Map entry point from the Popcorn lifecycle. These files are branch work, not an assumed dependency already available on the current `main` checkout. Review the existing extraction prompt against the completeness requirement above.

## Deliberate limits

This is a port of the linked MST/local-map experience, including fact-checking, with Echo integration. It is not a port of the entire DDW application or a redesign of Map. Standalone event setup, credentials and recording/showcase journeys are not required. Map controls that intersect those systems need an explicit integration decision based on the behavior checklist.

Public sharing, implementation of the follow-on Map display/presenter integration, new content editing/suggested-override features and the wider Analysis/Library change remain outside this slice. Deferring new edits here does not establish a rule that editing must live on another screen.

## Acceptance

- A fresh local database and an existing local database both accept the migrations; applying them twice is harmless. Verify a pgvector write/read and cosine-distance query against known vectors, and a Directus snapshot round trip that preserves the vector column and constraints.
- A real embedding smoke test records the configured model and actual dimensions. Reopening a result after API/worker restart makes zero embedding calls. Retrying the same persisted candidate result reuses its vectors; changed text or embedding configuration gets new rows without overwriting vectors used by older results.
- Stubbed provider/database failures verify bounded retries, partial-work reuse, no duplicate committed rows, and no ready result after a failed vector write. Invalid, zero or mixed-dimension vectors are rejected. Cross-project reads and writes are denied.
- Side-by-side review with the same representative data verifies the DDW map's intended appearance and interactions in Echo. Differences are attributable to Echo integration or documented bug fixes, not an unrequested redesign. Reproduced bugs have focused regression checks.
- Selecting or hovering in either renderer updates the linked highlighting and shared inspection/title state. Moving between renderers does not lose a retained selection or cause duplicate title generation. Verify local-map geometry independently from MST correctness.
- A fact-check initiated from the shared experience updates the same claim in both renderers and the detail panel, including status, verdict coloring, explanation and sources. Verify manual and optional automatic triggers, cancellation, failure/retry, deduplication and claim-revision changes with stubbed model responses.
- A project with no Popcorn session can generate and reopen a map from its transcripts. Representative results at 50, 150 and 200 nodes remain responsive during navigation and selection.
- Every argument has inspectable evidence; complete statements retain meaning without a presentation word limit.
- Valid embedded nodes form an acyclic connected tree with N−1 edges. Empty/single-node inputs work; invalid or missing vectors produce an explicit incomplete-result state rather than silently losing arguments.
- Verify graph-centre calculations on a small hand-checkable tree. Record whether centrality ordering already exists and the bounded addition, if needed, before implementing that affordance.
- A settled selection produces one title request, cache hits avoid another model call, and moving the cursor cannot display an old selection's response as the new title.
- Rendering a fixture needs no backend or Popcorn store. Running the recipe needs no renderer. Access checks apply to generation, results, evidence, selection titles and fact-check execution/results.

## Implementation handoff

Proceed from this spec into local implementation, resolving routine filenames, endpoint shapes and integration choices against the actual checkout. No additional design-document approval cycle is required. Read applicable server/frontend instructions before edits. Preserve the linked DDW frontend baseline and use fixture data to port it independently while implementing the server lifecycle.

Completion means the schema and SQL migrations are delivered and run locally, real embeddings are generated and survive restart, the linked frontend and fact-check flow work through Echo, and the acceptance checks have recorded results. Run relevant backend tests, frontend checks and translation extraction/compilation. Finish with a locally reviewable application and a concise list of observed bugs fixed or still open. Do not describe mocked embeddings or an unexecuted migration as a completed integration. If provider credentials or grounding access are unavailable, continue independent implementation and report the specific unverified integration.
