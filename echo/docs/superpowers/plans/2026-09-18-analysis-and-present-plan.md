# Analysis and Present: implementation plan

Plan for `../specs/2026-09-17-analysis-and-present.md`, written September 18th 2026 against branch `recipes` at 16a7cb88. Source-checked, no migrations run and no benchmarks executed.

The spec is a good target architecture. It is not a single release: 27 acceptance scenarios, three destinations with no implementation behind them, two renderer stacks to reconcile and a publication prerequisite with five numbered obligations. This plan sequences it as six bets, each shipping one thing a host can be shown, following the rule that generalisation starts at the newest service and the oldest gets extended rather than rebuilt.

Implementation and local verification are recorded in [the implementation record](2026-09-18-analysis-and-present-implementation.md). Production rollout and service-backed acceptance remain separate.

## Binding decisions

1. **No research-only milestone.** The spec's milestone 1 ("feasibility and contracts") ships nothing. The shell spike and the translation benchmark are folded into the bets they gate, as that bet's first task and its named pivot condition.
2. **The presentation object is popcorn's settings blob, generalised.** `popcorn/service.py:271` `default_settings` already holds title, client, tabs, public, show_qr, show_branding, voice, public_labels, opening blocks and language in one row. Split it into presentation settings and recipe settings in place, keep the session running on the same bundle, and give the presentation its own identity. Do not build a presentation subsystem beside popcorn.
3. **The audience shell wraps the deck; it does not replace or absorb it.** The deck keeps its `bundle.json` contract, its upstream patch set and its standalone URLs. The shell owns the presentation URL, block sequence and fullscreen context, and mounts the deck as one isolated renderer.
4. **Navigation lands per destination, not as one change.** The spec forbids empty placeholders and also lists the whole hierarchy inside one milestone. Resolve in favour of the former: each entry appears when its destination works. The pure-migration part (Conversations to the top, Manage consolidation, Host guide to contextual help) is independent and can land first.
5. **Shared authoring is last and gated.** The five publication prerequisites in the spec are correct and must pass before any editor is exposed. Per-presentation hiding is independent of them and ships earlier.
6. **`ENABLE_PRESENT` is a new independent gate.** It is applied in navigation, host BFF, public router and background producers in the same change. Canvas gates and `project.is_canvas_enabled` are left exactly as they are.

## What ships / what it pulls into the code

| Bet | What ships and gets shared | What it pulls into the code |
|---|---|---|
| 1. Press Present | A `/present` tab on a project with the Canvas beta off, landing on a default presentation, one button that opens a room screen with Popcorn in the project language | New `ENABLE_PRESENT` gate across nav, host BFF, `popcorn_public.py` and producers; presentation row with its own id, manifest and settings; idempotent concurrency-safe default creation with a server-derived title; `project.language` resolution table plus Directus metadata alignment; `/library/popcorn` re-parented to `/present` with a redirect and Library deep links preserved; `default_settings` split into presentation settings and recipe settings |
| 2. One screen, four blocks | One audience URL that switches Popcorn, Tensions, Stakeholders and Map without leaving the destination, and an editor preview showing the same thing | React audience shell; deck adapter (single-block control, suppressed deck navigation, opening block, paused hidden timers, versioned bridge with origin and presentation-identity checks); lazily mounted Map renderer with anonymous read endpoints and no workspace providers; audience capability boundary enforced at the data-access layer, including `useSelectionTitle`; manifest-driven block order |
| 3. Bilingual Popcorn | A Dutch phrase in an English project appearing at once and animating into English with time to read both, with crisper motion | Incremental translation dispatch from newly available phrase text, bounded batches, in-flight dedup, existing text cache keyed by target, source text and a policy version; deck popcorn as two language states of one identity; residency change from `HOLD = 10000` to a per-language interval with a hard cap, inside existing overlap and fairness guards; reduced-motion path; the benchmark suite |
| 4. Analysis you can read | An Analysis tab showing what was found, where it came from, what produced it, and one action appropriate to the state | Greenfield frontend analysis area on the existing read API; Map as a result view; contextual inspection panel inside the presentation editor with return-to-position; persisted per-presentation hiding; one state action per block (*Prepare*, *Update results*, *Try again*) |
| 5. Navigation migration | The agreed project hierarchy in the sidebar | `ProjectHomeView.tsx` and `ProjectSettingsView.tsx` reworked; Conversations to third; Access, Usage and General consolidated under Manage; Integrations and Export moved to Automation; Host guide into contextual help with its route retained; Library nav hidden with `ENABLE_CANVAS` untouched; redirects for every moved deep link |
| 6. Shared authoring and withdrawal | A host corrects a phrase and the room sees the correction | Effective membership resolved into a new immutable snapshot; authored objects preserved through whole-scope replacement; outbox-driven view advancement consumed by both Map and the deck projection; dependency invalidation for embeddings, assessments, relations and translations; durable reversible exclusion with audit history and cache invalidation; mutation APIs; four type-specific editors with conflict handling |

Bets 1, 3 and 5 are independent of each other. Bet 2 gates nothing but is gated by its own spike. Bet 4 depends on Bet 1's presentation object. Bet 6 depends on nothing above except that its prerequisites pass.

## Bet 1: press Present

Ships the spec's headline promise and nothing else.

**Gate work.** `api/feature_flags.py:18` `require_project_canvas_enabled` returns 404 unless the global flag is on *and* `project.is_canvas_enabled` is true, and that field defaults to `False`. `api/v2/popcorn_public.py:32` puts `require_canvas_enabled` on the whole public router. Introduce `ENABLE_PRESENT` and `require_present_enabled`, apply it to the new host routes, the public audience routes and any worker or producer gate reached from them, and audit legacy public-link aliases so the new tab cannot reach a Canvas-gated 404. Do not flip `is_canvas_enabled` and do not widen the Canvas gate.

**Presentation object.** One row per presentation with project, id, title, manifest, settings, result bindings and access configuration. Creation is idempotent under concurrent presses. Title derives from the project with a localized "Presentation" fallback; the legacy create endpoint requires a nonempty title, so either an adapter supplies it or a new endpoint derives it server-side. Creating the row is separate from asking a producer to run.

**Language resolution.** Implement the spec's table. Note that `frontend/src/components/project/ProjectPortalEditor.tsx:86` already writes `project.language` as `z.enum(["en","nl","de","fr","es","it","uk","cs"])` and line 243 already falls back to `en`, so the Directus dropdown's `en`/`nl`/`multi` is stale metadata on a varchar rather than a constraint. Align that metadata and API validation to the eight concrete codes while preserving stored `multi` and null. Audit every reader of the field before changing metadata.

**Project language reader audit.** The column remains a nullable varchar and existing `multi` rows remain valid. Presentation resolves concrete codes and locale forms directly, with `multi`, null and unknown values falling back to English and exposing the fallback reason. The portal editor uses English as its form value for those legacy rows but omits language from unrelated saves; only an explicit field change replaces the stored value. Participant links (`participant_url`, `ProjectQRCode`), transcription, verification, chat context, webhooks, Canvas gathering/ticks and project API serializers already use a concrete-code lookup or an English fallback. Directus metadata is therefore aligned by the prepared `directus/migrations/align_project_language_metadata.py` script without changing stored data; after it is run against local Directus, the snapshot must be pulled through `directus/sync.sh` rather than edited by hand.

**Route move.** `frontend/src/Router.tsx:279-303` nests `popcorn` under `library` inside `ProjectLibraryLayout`, with `canvases/:canvasId` behind the same `ENABLE_CANVAS`. Re-parent Popcorn into the project layout, redirect `/library/popcorn`, keep `library/views/:viewId` and its aspect route working, hide only the Library navigation item.

**Done when:** a project with the Canvas beta off opens `/present`, presses Present once, and a room screen shows Popcorn in the resolved language. Concurrent presses create one presentation. The old Popcorn URL redirects with its configuration intact. Acceptance scenarios 1, 2, 13, 17.

## Bet 2: one screen, four blocks

The spike is the first task, not a preceding milestone.

**Spike.** Mount the real vendored deck and the real Map renderer with its layout worker inside one React shell. Verify one stable URL across all four blocks, editor-preview parity, fullscreen and keyboard focus ownership, preserved stage position across block switches, resize, reconnect, permitted evidence, anonymous access, and cold load for N viewers on constrained venue wifi. That last item is the one the spec understates: `popcorn/view.py` inlines the stylesheet and both scripts so "the page needs nothing but its data endpoint", and the bundle memoisation exists precisely so a room of viewers costs one request per poll. Losing the single-document property is acceptable, but it has to be measured with a room, not as abstract network cost.

**Named pivot.** If one shell cannot hold that behaviour, the pivot is two audience destinations sharing one presentation manifest, and the spec's single-URL promise is revised in writing. Do not rewrite the deck into React and do not port the Map worker into vendored vanilla JavaScript.

**Adapter.** Single-block control, suppression of the deck's own navigation, opening-block selection, pause and resume on visibility, coherent configuration updates, error reporting. Versioned bridge with origin, source and presentation-identity checks. The old host-editing bridge stays dead. Today's `TOGGLEABLE_TABS` is `("tensions", "stakeholders")` and Popcorn is always present, so Popcorn omission, fixed complexity order, Map inclusion and opening-block choice all come from the new manifest, not from renaming the `tabs` settings.

**Capability boundary.** Enforce at the renderer data-access layer and again at the audience API. Disable generation, editing, fact-checks and `useSelectionTitle`, which is reached from `components/map/MapPage.tsx:337` and `components/map/panels/ExplorePanel.tsx`; audience selection uses prepared summaries or deterministic labels, and a cold cache must not fall through to the title endpoint. The authenticated preview receives the same reduced projection as an anonymous viewer.

**Done when:** all four blocks share one destination and one preview contract, hidden renderers stop their background work, a Map switch keeps fullscreen and keyboard, and no audience interaction reaches a model. Acceptance scenarios 3, 10, 16, and the audience half of 11.

## Bet 3: bilingual Popcorn

**Dispatch.** Translation currently runs in the tick's late phase (`popcorn/ticks.py:1258`) in batches of up to 40, four in parallel, 120 s per call (`popcorn/model.py:53-56`). Start dispatch from newly available phrase text instead, in bounded incremental batches, deduplicating in-flight work, reusing the existing cache keyed by target language and exact source text (`popcorn/translate.py:27`) with an added policy-version component. Reconcile leftovers through the existing session path; no second translation writer.

**Cache semantics.** Keep computation reuse keyed by text and target. Attach result-revision references for traceability only. A re-verification that does not change text reuses its translation; changed wording looks up its own entry and cannot inherit a stale one.

**Playback.** Original first, always, even when the translation is cached. One identity, one stage position, one focus state, one evidence reference, two language states. Pausing playback or opening evidence freezes the language cycle. Reduced motion uses an instant handoff with the same reading intervals.

**Reading time and throughput.** Each visible language state gets 3 seconds plus 0.5 seconds per word, calculated separately. An unheld appearance remains capped at 24 seconds; when both full intervals cannot fit, the original uses the first appearance and the translation takes the conversation's next eligible slot. Benchmark the resulting phrases per minute at realistic arrival rates.

**Benchmark.** Dutch-only, English-only and mixed input; cold and warm caches; arriving phrases, revised phrases, failures, two concurrent presentations. Record extraction to first original, extraction to first translation, p50 and p95 translation delay, share translated within the same stage appearance, queue growth and model-call cost against the shipped path.

**Named pivot.** If p95 cannot fit a stage appearance, fall back to the spec's own next-eligible-slot rule rather than extending residency further.

**Done when:** a mixed Dutch and English room reads both languages of each phrase, the first original never waits for a translation, a failure leaves the original readable with a host retry, and the agreed throughput holds. Acceptance scenarios 9, 15, 18.

## Bet 4: Analysis you can read

The backend read surface already exists in `api/v2/bff/analysis.py`: `GET /recipes`, `POST /projects/{id}/runs`, `GET /runs/{id}`, `POST /runs/{id}/cancel`, `GET /projects/{id}/objects`, `GET /projects/{id}/objects/{id}/revisions`, `GET /snapshots/{id}/revisions/{id}/lineage`. There is no frontend analysis area, so that half is greenfield.

Results first, then Recipes, then Runs, as local tabs. Map appears as a result view. Recipe detail shows inputs and instructions (source scope, the existing voice note and presets, and any parameter a recipe declares in its contract with type, default and bounds), results, actions and history. Prompts and checks are shown read-only behind an advanced disclosure; they stay versioned files and code.

The contextual panel inside the presentation editor reuses these components and returns to the same block, preview position and unsaved state. Per-presentation hiding becomes a persisted presentation capability; the server's current tab-hiding is not that capability.

**Done when:** a host can answer "where did this come from" without leaving the editor, and one state-appropriate action covers preparation, staleness and failure. Acceptance scenarios 4, 7, 21, 27.

## Bet 5: navigation migration

Split into two parts.

**Pure migration, independent of everything above.** Conversations to third in `ProjectHomeView.tsx`; Access, Usage and Settings/General consolidated under Manage; Integrations and Export relocated to an Automation entry; Host guide moved into contextual help on Overview, Portals and Monitor with its route retained; Library nav hidden. Every moved deep link keeps a redirect. Monitor keeps its existing functions, `ENABLE_MONITOR` gate and Beta badge.

**Per-destination appearance.** Present appears with Bet 1. Analysis appears with Bet 4. Automation appears when it holds the relocated integrations, not before it holds workflows. Overview's Project setup appears when the inheritance inventory is done; the spec is right that the actual precedence behaviour must be inventoried rather than invented to fit the menu.

**Done when:** an authorized host sees the specified order and groups, every previously reachable capability is still reachable, and no entry leads to a placeholder. Acceptance scenarios 19, 23, 24.

## Bet 6: shared authoring and withdrawal

Blocked until all five of the spec's publication prerequisites pass. The reason is recorded in `../plans/2026-09-16-recipes-acceptance.md:345`: snapshot assembly reads producer run manifests, so an authored successor revision does not reach a following view until its producer publishes again. The revision writer itself already protects authored heads, rejects conflicting saves and supports rollback, and a generated run over an authored head goes to `needs_review` with the ready output staying current. What is missing is the read path.

Order within the bet: effective membership and snapshot advancement first, with both Map and the deck projection consuming the outbox path; then exclusion as a durable reversible membership decision that survives reruns and invalidates audience caches; then the mutation APIs; then the four editors. Test edit, successor snapshot, adoption, rerun protection, whole-scope replacement, removal, restore, conflict and reconnect for each type.

Cutting authored editing does not make exclusion free. Only per-presentation hiding is independent, and it ships in Bet 4.

**Done when:** acceptance scenarios 5, 6 and 12 pass for all four types.

## Deferred with the spec's agreement

Monitor review queues, Automation execution, global Ask, additional saved presentations, custom-tool authoring, playbook orchestration and any new audience-access model. Their homes are settled in the spec; their contracts are not written. Do not estimate them from the navigation entry alone.

## Open decisions that need the host

1. **Resolved: Popcorn reading time.** Use 3 seconds plus 0.5 seconds per word for each displayed language state, with the 24-second appearance and next-eligible-slot rule above; validate achieved phrases per minute in the benchmark.
2. **Additional presentations in or out of the first release.** The spec leaves it open. It changes Bet 1's schema work only slightly and Bet 2's shell work not at all, so it can be decided late, but it should be decided rather than drifted into.
3. **Whether Bet 6 is in this quarter.** The spec explicitly declines to treat the recommended cut as a cancellation. Bets 1 to 5 are a coherent release without it; saying so out loud is cheaper than discovering it in week ten.
4. **Existing `multi` projects in the portal editor.** `ProjectPortalEditor.tsx:86` has no `multi` in its enum while line 243 casts `project.language` into that union, so a stored `multi` reaches the form as an invalid default. The spec plans the room screen's behaviour for `multi` and not this. It is adjacent, small, and in the same field's blast radius.

## Not in this plan

No commits, no pushes, no migrations. `recipes` is local at 16a7cb88 with the spec still untracked.
