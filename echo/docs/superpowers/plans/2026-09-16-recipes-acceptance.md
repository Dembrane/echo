# Recipes and the mixed map: acceptance, September 16th 2026

Spec: `docs/superpowers/specs/2026-09-15-analysis-objects-and-mixed-map.md`.
Plan: `docs/superpowers/plans/2026-09-15-recipes-mixed-map-plan.md`.
Branch `recipes`, local only, nothing pushed.

This is milestone M6: the extension proof, the failure and reconstruction
matrix, the recipe benchmarks and the traceable example. It goes through the
spec's acceptance list bullet by bullet and says what holds, on what evidence,
and what is not covered.

What this document does **not** do is speak for work it did not run. M2
(producers), M3 (snapshot, Map v2, migration), M4 (frontend) and M5 (popcorn,
stakeholders) own their own acceptance. Where a bullet is theirs, it says so and
names the evidence that exists rather than claiming a verdict.

## How to reproduce

Inside the dev container, from `/workspaces/echo/server`:

```
uv run pytest tests/analysis -q
uv run python tests/analysis/bench_recipes.py
uv run python tests/analysis/bench_recipes.py --store sql
uv run python tests/analysis/trace_example.py --read 4d73b749-1b8b-40d9-bc75-f88a1c0707cd
```

At `d7b5a08c`, which includes M2's quality iteration (`64c3552e`),
`tests/analysis` is 359 passed, 0 failed, with the Postgres tests running
against the local database rather than skipping. This milestone's own files are
32 of those: `test_integration_fixture.py` (5), `test_failure_matrix.py` (15)
and `test_failure_matrix_sql.py` (12), all re-run against that commit.

M5's popcorn and stakeholders recipes landed while this was being written, so
all six recipes are now registered builtins: `arguments`,
`deduplicated_arguments`, `tensions`, `popcorn`, `stakeholders` and
`integration.fixture_delivery`.

## The spec's acceptance list

**Legacy arguments keep PR #1074's appearance, interactions and fact-check
behaviour inside the new budgets; oversized legacy results stay inspectable and
can be scoped without regeneration.** Holds on the backend, not verified by me
in the browser. `tests/analysis/test_map_v2_graph.py::test_an_unimported_v1_result_is_served_in_the_v2_shape_and_its_v1_routes_still_answer`
serves an unimported v1 result in the v2 shape with its legacy provenance and
keeps the v1 fact-check route answering, and shows an over-budget legacy result
returning counts without reading its vectors. The appearance itself is M4's.

**A fixture and a real local project show raw and deduplicated arguments,
popcorn, tensions and stakeholders in both renderers within the node cap; type
filters and colour modes make no generation requests; geometry does not restart
for colour or verdict updates.** Partially covered, and the part I own holds.
That filters and budgets start no work is
`test_failure_matrix.py::test_row_filters_and_budgets_start_no_extraction_deduplication_or_delivery`:
four different type selections and budgets over one snapshot leave the run
count, the model call count, the outbox, the revision count and the snapshot
itself identical. The five types together in both renderers, and geometry not
restarting on a colour change, are M4's and I did not run the frontend suite.
Popcorn and stakeholders are M5's; their recipes landed late today and I did not
verify them.

**Every generated tension links to exact arguments on both poles with
inspectable source evidence; replacing an argument revision makes the dependent
tension stale without rewriting history; the deck and Map show the same
revision.** Holds for the first two. The traceable example below shows one
tension with both poles held by exact deduplicated argument revisions, each
expanding to its raw arguments and their quoted sources.
`test_failure_matrix.py::test_row_a_changed_dependency_leaves_tensions_pinned_and_stale_without_retargeting`
and its SQL twin show the completed tension keeping its pinned inputs, being
marked stale, and its support edges still naming the revisions they were
established against after those objects moved on. The deck adapter showing the
same revision is M3's.

**Popcorn appears from the same producer output as its presentation screen and
generation from either entry point deduplicates.** Not covered here. This is
M5's, whose recipes and import tests landed while this was being written. I did
not verify them.

**Retry, concurrent refresh, stale worker, invalid schema or reference and
database failure tests verify atomic publication and unchanged prior ready
outputs; one producer's failure cannot remove another type.** Holds. This is the
failure matrix below, rows 3, 4, 5 and 7, in memory and against Postgres.

**Revisions reconstruct prior content and dependencies; an edit conflicts
rather than overwriting a newer head; reworded claims do not inherit verdicts.**
Holds. `test_row_lease_order_and_expected_head_decide_competing_writes` and
`test_row_racing_edits_on_one_object_let_exactly_one_win` (the latter meeting at
a real lock through `conftest.race`) show one winner and a `RevisionConflict`
carrying the current head, and a generated run over an authored head going to
`needs_review` while the ready output stays current. That a re-check appends
rather than erases is `test_row_a_recheck_advances_the_view_and_the_shared_snapshot_keeps_its_assessment`.

**Fresh, upgrade, backfill and second-run migrations preserve vectors, Map
results, popcorn history and public links.** Not covered by me. This is M3's
backfill and M5's popcorn import; `test_backfill.py` and `test_import_paths.py`
are theirs. What I can say is that unchanged inputs reuse their vectors: the
benchmark's refresh pass computes no embedding, and
`test_row_a_repeated_regenerate_request_returns_its_run_and_a_new_one_opens_an_epoch`
shows a new epoch asking the model again while the identical statements reuse
their stored vectors.

**The fixture integration type is added through schema and recipe registration
without editing execution internals or graph algorithms, and inspecting its
payload causes no external write.** Holds, and this is the milestone's main
claim. See "The extension proof" below.

**Recipe metadata exposes ordered steps, output schemas and checks, and
executions retain check outcomes and version references.** Holds.
`test_the_payload_is_inspectable_as_json_through_the_runs_api` reads the new
recipe out of `GET /recipes` with its three ordered steps and its output schema,
and reads the run out of `GET /runs/{id}` with its immutable step definitions,
its check outcomes and its output summary. The traceable example prints the
recipe version, every declared step with its version, and every check outcome
for all three producers, read back from saved rows.

**Budget tests around nodeLimit-1, nodeLimit and nodeLimit+1, empty and
single-node states, an over-budget scope not starting layout or fetching its
vectors, and raising the budget admitting it without regenerating.** Holds on
the backend, and it is M3's and M4's test rather than mine:
`test_map_v2_graph.py::test_the_node_budget_admits_its_limit_and_only_counts_beyond_it`
is parameterised over exactly those three points at the default and a raised
limit and asserts that an oversized scope reads no revision, relation or vector.
My row 10 adds that raising the budget admits the objects again without any run
starting. Settings persisting across reloads and frontend and backend limits
agreeing are M4's.

**Dense-relationship fixtures never draw more than edgeLimit and always retain
the MST's N-1 edges.** Not covered by me. M4's, in the renderer tests and
`components/map/layout/BENCHMARKS.md`.

**Deduplication retains original argument revisions, accounts for every input
and preserves minority and opposing positions; derived evidence expands to
original arguments and transcript sources; changed inputs invalidate freshness
without rewriting history.** Holds.
`test_row_a_similarity_chain_fails_verification_and_keeps_its_distinctions`
drives a real A to B to C chain through the executor: with the threshold lowered
so all three become one candidate group, a verifier that judges one end apart
blocks the merge, nothing holds both ends, every input is accounted for exactly
once, and the original arguments and their evidence are untouched. The
traceable example shows the derived evidence expanding from a deduplicated
argument to its two raw arguments and their quoted sources. Freshness is row 6.

**Demonstrate recipe-stage reuse, bounded concurrency and cancellation without
lost checkpoints, and record recipe benchmarks separately from the
visualisation ones.** Stage reuse and checkpoints hold: see the benchmarks and
rows 1 and 3. Cancellation without lost checkpoints is the foundation's
`test_executor.py::test_cancelling_stops_the_worker_at_its_next_checkpoint`, and
bounded concurrency is `test_a_recipe_at_its_running_limit_defers_the_next_run`
and the SQL `test_b11_concurrent_claims_respect_the_running_limit`; both are M1's
and both pass. The recipe benchmarks are below and are deliberately kept apart
from `frontend/src/components/map/layout/BENCHMARKS.md`, which measures the
browser.

## The extension proof

`dembrane/analysis/recipes/integration_fixture.py` registers one object type
(`integration.delivery_payload`) and one recipe
(`integration.fixture_delivery`), and nothing else changed. No executor, store,
snapshot or graph file was touched to make it work. It turns selected argument,
deduplicated argument and tension revisions into a payload shaped like an
external API's request body, stores it as a revision of one object per
destination scope (`delivery:<name>`), and sends nothing.

What the tests assert, in `tests/analysis/test_integration_fixture.py`:

- the stored payload is exactly what its declared schema accepts, its items
  name the pinned revisions and carry the recipe that produced each, and its
  `idempotencyKey` is the hash of the body as the schema normalises it, so a
  receiver can derive the same key from the bytes it was sent;
- generation makes no outbound request. The test patches
  `httpx.AsyncHTTPTransport.handle_async_request`,
  `httpx.HTTPTransport.handle_request`, `requests.adapters.HTTPAdapter.send` and
  litellm's `embedding`, `aembedding`, `completion` and `acompletion` to record
  and refuse, and asserts none was reached. The ASGI transport the API tests use
  is left alone, so this catches real egress rather than the harness. The recipe
  also declares no model step at all, so there is no stage in it that could call
  a provider;
- it has no graph projection: the type is not in `MAP_TYPES`, its `map`
  capability is `None`, `map_producers` does not list its scope, the map
  snapshot does not pin it and the graph payload never counts or draws it;
- it is inspectable as JSON through the runs API, and not through the map
  objects listing, which refuses the type with a 422;
- an unchanged selection reuses the ready output, and a destination whose limit
  is smaller than the selection fails its check rather than quietly cutting the
  body to fit, leaving the previous ready output current.

The one design decision worth recording: the idempotency key is taken over the
body *after* schema normalisation. The first version hashed the pre-validation
dict, which meant the key could not be re-derived from the stored or delivered
bytes, because `exclude_none` strips optional keys. That defeats the purpose of
a delivery key, so `build_body` now normalises each item through `DeliveryItem`
before hashing.

## The failure and reconstruction matrix

One test per row of the spec's table, against the real registered producers
(`arguments`, `deduplicated_arguments`, `tensions`) with scripted models, plus
the integration recipe. In memory in `tests/analysis/test_failure_matrix.py`;
the rows whose guarantee is the database's own are repeated against Postgres in
`tests/analysis/test_failure_matrix_sql.py`.

| Spec row | Result | Test |
|---|---|---|
| Repeat Refresh with unchanged inputs | pass | `test_row_repeat_refresh_reuses_artifacts_and_calls_no_model`, and the SQL `..._reuses_the_ready_output_and_calls_no_model`. All three recipes return `reused` with the earlier run's manifest, and no model or embedding call happens. |
| Repeat transport request for Regenerate | pass | `test_row_a_repeated_regenerate_request_returns_its_run_and_a_new_one_opens_an_epoch`. The same key returns the same run; the run opens a new epoch and asks the model again; the identical statements reuse their stored vectors; a new key opens the next epoch. |
| Crash after saved extraction or embedding | pass | `test_row_retry_resumes_saved_stages_and_the_former_worker_cannot_publish`, parameterised over a crash mid-extraction and a crash at a late tension judgement, and the SQL `..._retry_resumes_saved_steps_and_the_former_lease_cannot_publish`. The retry resumes the saved steps under a new lease, does not re-read what was already read, embeds no statement twice, and the crashed worker's lease can neither publish nor heartbeat. |
| Crash during publication | pass | `test_row_a_crash_during_publication_commits_nothing_and_keeps_the_ready_output` and its SQL twin, each parameterised over the four fault points inside the publication transaction. Heads, scope pointers and the outbox are unchanged, the run's revisions stay staged, and the previous ready output still assembles into a snapshot manifest. |
| Crash after commit, before notification | pass | `test_row_a_failed_notification_is_retried_and_a_duplicate_dispatch_reruns_nothing` and its SQL twin. The event goes back to pending with its attempt recorded; two concurrent dispatches claim it once and deliver it once; no dependent work reran and the publication sequence did not move. |
| Dependency changes while tensions are complete | pass | `test_row_a_changed_dependency_leaves_tensions_pinned_and_stale_without_retargeting` and its SQL twin. The tension output is byte-identical afterwards, no judgement was asked again, the snapshot marks it stale, and every support edge still names the revision it was established against while at least one of those objects has moved on. |
| Two publications or an edit race for one scope | pass | `test_row_lease_order_and_expected_head_decide_competing_writes`, plus the SQL `..._request_order_supersedes_an_older_run_publishing_later`, `..._racing_edits_on_one_object_let_exactly_one_win` and `..._two_requests_racing_with_one_key_get_one_run`, the last two meeting at a real lock. |
| Re-check a claim after a snapshot was shared | pass | `test_row_a_recheck_advances_the_view_and_the_shared_snapshot_keeps_its_assessment`. The following view advances to a successor snapshot, the shared snapshot still resolves the verdict it was shared with, and both assessments are kept as revisions of one object. |
| Similarity chain A to B to C | pass | `test_row_a_similarity_chain_fails_verification_and_keeps_its_distinctions`. Described above. |
| Hidden type or raised rendering budget | pass | `test_row_filters_and_budgets_start_no_extraction_deduplication_or_delivery`. Four selections and budgets over one snapshot change nothing: no run, no model call, no outbox event, no revision, and no delivery either. |
| Source becomes unavailable | pass | `test_row_an_unavailable_source_is_marked_missing_and_never_substituted`. With the conversation gone from the project, historical inspection still shows the source references checked when the revisions were written, and never re-resolves them against what the project holds now. A pinned revision that no longer resolves is reported in `missing`, is absent from the resolved set, and its edge still names it rather than a stand-in. |

One extra test, `test_the_two_stores_publish_the_same_output_for_the_same_world`,
runs the same world through the in-memory store and Postgres and compares object
counts, relation counts and check names, so the in-memory matrix is evidence
about the database's behaviour and not only about the fake.

## Recipe benchmarks

`tests/analysis/bench_recipes.py`, manual, never collected by pytest. It changes
no default. These are the recipe numbers and are kept apart from
`frontend/src/components/map/layout/BENCHMARKS.md`, which measures the browser.

The world is the three-conversation recording debate plus twelve generated
conversations, six of which carry a near-duplicate, so 15 conversations
producing 62 arguments, 54 deduplicated arguments (62 `derived_from` relations)
and 1 tension with 2 support relations. Models are scripted, so the wall times
are the lifecycle's own cost (cache keys, hashing, staging, publication and, in
sql mode, the real storage), never a provider's latency. Three passes: cold,
refresh with the same inputs, and incremental with one conversation changed.

Re-measured against `64c3552e`. The numbers below are unchanged within
run-to-run variation, and the call counts are identical.

| Pass | Recipe | memory | sql | model calls | tokens | cache hits |
|---|---|---|---|---|---|---|
| cold | arguments | 0.009 s | 1.39 s | 15 | 1800 | 0 |
| cold | deduplicated arguments | 0.23 s | 1.78 s | 7 | 840 | 0 |
| cold | tensions | 0.007 s | 0.44 s | 10 | 1200 | 0 |
| refresh | arguments | 0.0003 s | 0.026 s | 0 | 0 | whole output reused |
| refresh | deduplicated arguments | 0.0005 s | 0.037 s | 0 | 0 | whole output reused |
| refresh | tensions | 0.001 s | 0.052 s | 0 | 0 | whole output reused |
| incremental | arguments | 0.005 s | 0.88 s | 1 | 120 | 16 |
| incremental | deduplicated arguments | 0.009 s | 1.25 s | 1 | 120 | 7 |
| incremental | tensions | 0.006 s | 0.42 s | 9 | 1080 | 2 |

What the numbers say:

- **Refresh is free.** All three recipes return the existing output with no
  model call, no embedding and no new revision. In sql mode the whole refresh
  pass is about 0.11 s, which is three round trips to resolve inputs and record
  the reuse.
- **Incremental work is proportional to what changed.** One changed conversation
  out of fifteen re-reads one conversation (14 of 15 extractions reused), leaves
  60 of 62 argument objects untouched and stages 2, and re-verifies one of seven
  candidate groups (52 of 54 deduplicated objects reused). Both embed steps are
  reused whole.
- **Cold deduplication dominates in memory** (0.23 s against 0.009 s for
  extraction) because the similarity matrix is quadratic per kind and valence
  partition. At 62 arguments that is nothing; the plan already records that the
  benchmark ladder decides whether indexed neighbour discovery is needed, and
  nothing here contradicts that.
- **Storage is the cost in sql mode**, roughly 100 to 150 times the in-memory
  time on the cold pass, because every staged revision, relation and step is a
  row. Tensions stay cheap in both because they produce one object.
- Tensions re-run their judgements on the incremental pass (9 of 10 calls) even
  though only one of their inputs moved. That is the recipe's own design (the
  collisions stage reads the whole argument listing), not a caching failure.
  This still holds after `64c3552e`, and it is now with M2 as a recipe-design
  question; nothing is owed by this milestone.
- This benchmark does **not** reproduce M2's headline reduction from 130 calls
  and 698k tokens to 49 and 242k. That figure comes from a real run. The world
  here is scripted and small, so batched collisions have nothing to batch: the
  collisions stage makes the same six calls before and after. Read their number
  for the real corpus and these for the lifecycle's own overhead, never one as
  a check on the other.

I did not run a real-model pass. The scripted-model numbers answer what this
milestone is accountable for, which is the lifecycle's overhead and its reuse
behaviour; provider latency and real token counts are a separate measurement and
would cost tokens on every run of this script.

## The traceable example

`tests/analysis/trace_example.py`. `--seed` writes a scratch project through the
real SQL store with scripted models and keeps it; `--read <snapshot id>`
resolves everything from the database in a new process, with a new store, making
no model call and reading no transcript. It was seeded once and then read from a
separate process, which is what "after the API and workers restart" means here.

Re-seeded against M2's quality iteration (`64c3552e`) and saved on the local
database on September 16th 2026:

| What | Id |
|---|---|
| project | `65dc7e41-5d5b-4f67-b76a-bb16dfe5c967` |
| map snapshot | `4d73b749-1b8b-40d9-bc75-f88a1c0707cd` |
| tension revision | `0c8b0729-2bf2-41e9-b90b-88d80b01b7bc` (object `4a1adb1a-3f00-4b63-bbc0-c5aab4d6795d`) |
| pole A, deduplicated argument | `07a2327a-23cb-421b-a03a-78ef9a23de5d`, verification `verified` |
| its raw arguments | `9148345c-439e-4643-9e44-214c87c18ff6`, `f2670db9-aabf-4148-ab45-94d6178461aa` |
| pole B, deduplicated argument | `cbe96714-fe0c-4844-9f9b-92ebd928c16a`, verification `singleton` |
| its raw argument | `88ea719a-60d9-4f58-bf30-5570deace68f` |
| assessed claim revision | `696e5f5b-2445-4da8-9a56-7452d5279f92` |
| assessment revision | `0eca2b77-65e0-469a-b1d7-1d2aeaaa5c71`, verdict `true` |
| arguments run | `845e3610-ded4-45ec-88a5-13e25408216a` at `arguments-v1` |
| deduplicated arguments run | `6f8d651e-7ebe-4ce3-8056-24de40622e16` at `dedup-v2` |
| tensions run | `86596442-9668-4747-b628-33b45fb465d2` at `tensions-from-arguments-v2` |
| assessment run | `79c4acfc-d81a-41d9-bdfe-ea2c2e7e4c3e` at `fact-check-assessment-v1` |

The read prints the tension's poles, knot and question; each pole's
deduplicated argument with its verification outcome and source references; each
of those expanded to the raw arguments it consolidates, with their own quoted
sources and conversation ids; every run with its recipe version, its ordered
step definitions with versions, and every check outcome (for the tensions run:
schema, references, embeddings-durable, evidence-grounded, both-poles-supported,
support-confirmed, tension-coverage and screen-gate, all passed); and the
assessment records. Six lineage revisions resolved, nothing missing.

**Re-run against M2's quality iteration.** The ids above are from that re-run,
not from the earlier one, whose scratch project has been dropped. The shape held
across the change: the same two poles, the same consolidation outcomes
(`verified` on pole A, `singleton` on pole B), the same eight checks passing on
the tensions run, six lineage revisions resolved and nothing missing. Only the
identifiers moved, because `--seed` mints a new project each time. That is the
expected result for this fixture: its statements are scripted, so the parts and
wholes rule and the contrast words that v2 adds have nothing to bite on here.
They are exercised by M2's own corpus, not by this example.

`--drop <project id>` removes the project above when it is no longer wanted.

## What is not covered

Named plainly, so nothing here reads as more finished than it is.

- **Popcorn and stakeholders are M5's and I did not verify them.** Both recipes
  landed while this was being written and their tests pass, but no row of my
  matrix exercises them and nothing here signs off their acceptance. The bullet
  about all five types in both renderers stays theirs and M4's to close.
- **The editing UI is deferred**, as the plan says. The storage contract behind
  it is exercised (authored edits, conflicts, rollback, candidates over authored
  heads) but there is no interface.
- **Authored edits do not advance a following snapshot.** Snapshot assembly
  reads producer run manifests, so an authored successor revision does not
  appear in a following view until its producer publishes again. This is
  recorded in the plan as a known limit of this slice and in `map_view.py`'s own
  docstring. Historical snapshots keep their original manifests either way.
- **Translations are not implemented.** The spec describes them referencing
  exact source revisions; nothing here does that yet.
- **No real integration and no delivery.** The fixture recipe builds a payload
  and stores it. There is no connector, no credentials, no authorization, no
  destination and no outbound write, by design. Delivery will need its own
  authorization and receipt referencing the exact payload revision.
- **The frontend is not verified by me.** Renderer behaviour, edge budgets, the
  MST's N-1 edges, settings persistence and geometry not restarting on colour
  changes are M4's, in their own tests and benchmarks. I ran the server suite
  only.
- **Migrations are not verified by me.** Fresh install, second application,
  backfill and the popcorn import belong to M1, M3 and M5.
- **No real-model benchmark pass**, as explained above.
- **The tensions recipe re-asks most of its judgements when one input changes.**
  Observed in the incremental benchmark pass, and still true after `64c3552e`.
  It is a recipe design question now open with M2, not a lifecycle defect, and
  nothing in this milestone is blocked on it.
