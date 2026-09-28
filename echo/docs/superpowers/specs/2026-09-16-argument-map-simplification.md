# Argument map: one set of arguments, visible merges, deliberate large maps

Status: implemented locally and verified. Supersedes the mixed-object defaults, Objects controls and list fallback in `2026-09-15-analysis-objects-and-mixed-map.md`. The shared Recipes architecture remains in place.

## Intent

A host opens Map to explore arguments. They should not need to choose between raw arguments and deduplicated arguments, or understand the storage model. Consolidation should become visible only where arguments actually merge. Other recipe outputs remain available to their existing views and integrations; mixed-object mapping is hidden from this experience for now.

This is a focused local change on the existing implementation, not a rewrite of Recipes, extraction, embeddings or layout. Keep the linked minimum spanning tree and local map, selection, Explore summaries, evidence and fact checking.

## One argument set

The normal map always selects arguments, irrespective of the number available. It never substitutes popcorn, tensions or stakeholders to fit a budget. Remove the Objects control and its generation shortcuts, object-type legend and type-color option from the normal map. Existing saved settings and old URL parameters selecting other types must not bring those controls or nodes back. Retain the underlying types, adapters, recipe registry and explicit API capabilities for future use.

Call the displayed items Arguments throughout this experience. There is no Raw/Deduplicated toggle. Prefer the completed consolidation output applicable to the selected argument scope and pinned input revisions. Otherwise show the original arguments. Do not show originals alongside the consolidation outputs that replace them, or let an older consolidation hide newer arguments. For a partially covered or stale argument set, use original arguments until a current, complete consolidation is available; never imply that unrelated outputs are replacements. Explicit historical scope selection still refers to the requested historical output.

An unchanged consolidation is a valid result: the same number of ordinary argument nodes, with no duplicate tab, no badge of 1 and no claim that arguments were merged. Missing or failed consolidation is also not an empty-map condition when arguments exist. A project containing only other object types gets the existing argument generation empty state.

Default coloring is neutral. Valence and factual-status coloring remain available. Object-type coloring stays implemented underneath but is unavailable in this map UI; previously saved type coloring resolves to neutral. Related objects may remain accessible in the inspector as context, without promoting them to map nodes or exposing a type picker.

## Show actual merges

When two original arguments contribute to one consolidated argument, draw one slightly larger node with 2 centered inside it. The count means contributing original argument objects, not quotes, participants, agreement, importance or confidence. Singleton nodes retain their existing size and no count label. Apply the same convention in both renderers.

Use a bounded monotonic size scale, for example `min(1.8, 1 + 0.2 * log2(memberCount))`, so a large merge remains legible without dominating the map. Node picking, focus rings and local collision geometry must use the displayed size. The count must stay readable against every supported color mode and have accessible text in the selected-node inspector.

Selecting a merged node explains “Combined from N arguments” and displays the contributing statements with their existing source evidence where available. Read pinned source revisions, not current heads, so the explanation matches the merge. Do not add original members as extra nodes or synthetic tree edges. A missing historical source is shown as unavailable, never silently counted as a recovered statement.

Transport contract: graph nodes may carry `detail.consolidation` with `memberCount` and `members` (`objectId`, `revisionId`, `statement`, and evidence when available). The backend derives members from the revision's pinned argument inputs or validated `derived_from` relations within the same project. Count unique original argument object identities. Only verified lineage creates a merge badge; arbitrary numeric payload metadata alone is insufficient. For imported legacy results, trusted provenance can carry original candidate IDs without recoverable original statements: count those unique candidates and add `legacy: true`, leaving `members` empty. The inspector explicitly says the original statements are unavailable for this older result. Payloads lacking lineage remain ordinary singleton nodes. Preserve internal node and revision IDs for all operations.

## What deduplication means today

The current recipe in `server/dembrane/analysis/recipes/deduplication.py` supports both exact duplicates and semantic equivalence. Identical statement text, epistemic kind and valence form exact units. Embedding similarity proposes candidate groups using complete linkage; it does not establish equivalence. A language model checks proposed replacement statements against every member. Code accepts a semantic merge only when every member is accounted for and judged equivalent, and kind and valence agree. Distinct positions stay separate. Discovery and verification limits can leave possible duplicates unmerged.

There is no target reduction and no requirement to reduce a set to the rendering threshold. An output count equal to its input count is not proof that deduplication was skipped, nor proof that no semantic overlap exists. Do not loosen the equivalence criteria just to make the map smaller.

During implementation, inspect the local Democratic AI result read-only and record whether its 203 displayed arguments come from extraction or consolidation, the input/output counts, actual multi-member merges and any recorded candidate/verification limitations. If the relevant run is unavailable, state that limitation instead of inferring from the visible count. No automatic paid rerun or rewriting existing analysis data is necessary for this UI correction.

Local audit: Democratic AI #2 workshop has a legacy `map-arguments-v1` result with 210 candidates and 203 published argument nodes. Its manifest records seven merges: 197 singleton nodes, five nodes containing two candidate IDs, and one containing three. It used identical statements or embedding complete linkage at cosine threshold 0.8 with `vertex_ai/text-embedding-004`, constrained to the same kind and valence. That older pipeline did not apply the new recipe's per-member language-model equivalence verification. No new `arguments` or `deduplicated_arguments` run exists for this project in the inspected local database. The current snapshot contains 203 arguments and 84 popcorn objects. Original pre-merge statements were not retained by the legacy pipeline, so the UI can show its preserved merge counts and evidence but cannot reconstruct those statements.

## Large maps: warn, then open the same set

Keep the configurable node threshold, default 150, and configurable edge budget. Above the threshold, show a warning before loading vectors or starting layout. Suggested copy: “This map has N arguments. Rendering it may be demanding on your device.” Primary action: “Open map”. The host can leave the warning without any layout work starting. Do not fall back to a smaller object type, truncate the selected arguments or switch to a list.

Opening grants permission for this map scope in the current page session. Use the existing budget request mechanism to admit its count without silently saving a larger default. Keep the saved threshold unchanged. The permission is tied to project, result/snapshot, selected argument scope and count; changing scope or receiving a new result invalidates it. A fresh page load prompts again. No consent query parameter or saved setting should automatically grant this temporary permission.

Use the admitted budget consistently in the API query and geometry worker. Make room for all N-1 MST edges; optional overlays may still be limited by the edge budget. Respect separately configured deployment hard ceilings. If a hard ceiling prevents opening, explain the actual limit and keep the selected argument set; never offer an Open action that cannot work. A configurable warning threshold is not an unlimited allocation promise.

The worker remains cancellable and off the UI thread. No algorithm rewrite is required here. Count-first responses and existing cache keys must continue to work, including reopening the same admitted result without a request loop. Loading/error states after confirmation must be recoverable.

The page's parallel project-status request must also avoid vectors: request `metadata_only=true`, with its own query key and ETag, to obtain progress and current result/snapshot identity. Fetch the full compatibility result only if the graph endpoint is unavailable. Use the compatibility response's `snapshot_id` when comparing it with the graph's snapshot ID; a result-row ID is a different identity.

## Simplify the surface

Remove the standalone List view and Map/List switch. Small results open as maps too, with the existing empty/single-node handling. Old `view=list` links resolve to the map. Keep lists needed inside inspectors and Explore, such as contributing arguments and evidence; these are not the removed alternative view. Arguments without usable embeddings get an honest notice and an inline way to inspect the missing arguments, without reinstating a full list mode.

Fix Explore's contributing-argument text with explicit compact line height rather than an inherited large body line height. Use existing typography tokens. Square map tabs, panels/cards, secondary buttons and other rectangular map controls. Only the primary call to action may retain rounded corners. Graph circles, circular selection handles and other meaningful geometry are unaffected. Keep the change local to map UI rather than changing the application theme.

Translate new copy with Lingui across supported locales. Keep normal copy about arguments, not objects, revisions or deduplication machinery.

## Verification

Meaningful automated coverage must establish:

1. A large argument set plus a small popcorn/tension set still selects arguments and warns. No vectors/layout before confirmation; the identical argument set loads after confirmation.
2. Confirmation does not persist a larger node threshold, survives ordinary rerenders, and resets for another result/scope. Deployment ceiling handling remains truthful.
3. Current complete consolidation replaces its originals once. Stale/partial consolidation cannot hide newer originals. Equal-count singletons show ordinary arguments. An absent argument set never falls back to other types.
4. A two-member merge has count 2, bounded larger size and inspectable pinned members in both maps. Singleton and legacy payloads have no merge count. Counts do not depend on quote count.
5. Existing mixed-object URL/settings and list links cannot restore hidden UI. Fact checking, source links, linked selection and Explore still work.

Run targeted backend and frontend tests plus frontend type checking. Inspect the running map for compact Explore text, square tabs, visible merge counts and the large-map warning if the local stack/data are available. Leave the user's existing Directus operations change untouched. No migration, push or PR publication is part of this change.

## Implementation ownership

After this specification is written, delegate to Sol agents at medium reasoning:

- Backend: argument default/projection, current-input coverage, pinned merge lineage payload and server tests.
- Map page: argument-only surface, saved/URL state compatibility, removal of list mode, temporary large-map admission and tests.
- Renderers/inspector: merge metadata adapter, node counts/sizing, member inspection, Explore typography and square map chrome, with focused tests.

The coordinating agent owns integration review, local data investigation, translations and final verification. Agents share this checkout and must keep file ownership separate; coordinate contract changes before crossing another agent's files.

## Verification record

- Sol agents at medium reasoning implemented the backend, page and renderer slices.
- Frontend Map suite: 331 tests passed across 29 files; one benchmark skipped. TypeScript checking passed.
- Targeted server Map regressions passed, including consolidation coverage, legacy merge lineage, count-first graph responses, metadata-only status responses and distinct metadata ETags. Targeted Ruff and frontend Biome checks passed.
- New copy translated across all eight configured locale catalogs; Lingui compilation passed.
- Browser check on the local Democratic AI map: warning at 203 arguments, full 203-node MST and local map after Open map, five two-member labels and one three-member label in each renderer, and the two-member inspector's historical-source explanation. Saved node threshold remained 150. Reload returned to the warning with no rendered graph labels. Explore contributing text measured 12px with 16.5px line height; title line boxes were also corrected.
- Validated on the existing `recipes` branch. The pre-existing Directus operations modification was not edited. No database migration was required.
