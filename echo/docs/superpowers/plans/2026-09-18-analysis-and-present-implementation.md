# Analysis and Present: implementation record

The six implementation bets are present in the local working tree behind `ENABLE_PRESENT`. This is implementation and local verification, not a production rollout. No commits, pushes or migrations were performed.

## Delivered

| Area | Behavior |
| --- | --- |
| Present | Idempotent default presentation, Popcorn only, project-language policy, explicit preparation of missing selected tools, existing result adoption without regeneration |
| Presentation editor | Intro, Data policy and Activities; title, activity order and opening activity, language overrides, display settings, sharing, contextual evidence and presentation-local hiding |
| Room screen | One URL for Popcorn, Stakeholders, Tensions and Map; isolated deck bridge, fullscreen, keyboard navigation, pause/resume, anonymous published links and authenticated preview using the same audience projection |
| Popcorn | Original first, then translation; each language gets 3 seconds plus 0.5 seconds per word, with the bounded next-slot rule; incremental translation and unchanged-text cache reuse |
| Analysis | Results, Recipes and Runs; bounded pagination, source evidence, history, typed recipe parameters, voice settings, scoped refresh/retry/regeneration and live updates |
| Shared authoring | Four typed result editors, expected-revision conflicts, rollback, withdrawal and restore; immutable successor snapshots; authored results protected through reruns; withdrawal applied over pinned audience results |
| Navigation | Overview, Ask, Conversations; Portals, Monitor, Present; Analysis, Report, Automation; Manage. Library hidden under the new flag, retained deep links, contextual Host guide |
| Map audience | Linked tree and local views, neutral default, display controls, selected-item details and existing assessments. No title generation, fact-check invocation or host transcript endpoints |
| Languages | Eight target-language policies, legacy project language preservation, eight static deck dictionaries and data explanation copies; new translation assets are drafts awaiting native-speaker review |

The Map and deck share effective analysis membership and an outbox-driven publication path. Tensions, Stakeholders and Map use explicit result bindings; current withdrawal overrides historical bindings. Popcorn continues following live output. Presentation settings do not mutate source findings.

## Verification

- Backend regression suite: 426 passed, 51 skipped. Includes Present, project-language lifecycle, Popcorn service/view/model/dispatch/translation/ticks, translation harness and the Analysis suite.
- Frontend regression suite: 357 passed, 1 skipped across Present, project-language resolution, sidebar scope and existing Map tests. Two additional vendored bridge regression tests passed after the browser-discovered reconnect fix. The final focused Present suite passed all 10 tests.
- TypeScript compilation, Lingui extraction/compilation and production Vite build passed. Vite reports its existing chunk-size advisory and stale Browserslist data.
- Browser check used the real vendored deck, real Map renderers and worker with synthetic HTTP fixtures. All four tools stayed on one URL, with no page errors and GET-only audience requests.
- Timed browser check: a three-word original changed to its translation after approximately 4.6 seconds, against a 4.5-second interval. Pausing for five seconds delayed that transition to approximately 9.6 seconds and preserved the original throughout the pause.
- Browser verification caught repeated deck-ready messages rebuilding the stage. The receiver now ignores a repeated current-block command; a regression test exercises the actual receiver.
- Public-token revalidation clears loaded iframe and Map content on revocation. Bridge tests reject other windows, origins, versions and presentation identities.
- No model provider was called for these checks. The translation benchmark is synthetic and does not establish real provider latency or cost.

Node 25 exposes experimental web storage that interferes with the existing jsdom Map tests. The passing frontend run used `NODE_OPTIONS=--no-experimental-webstorage`.

## Local activation and release checks

The frontend flag is enabled for the local environment and disabled elsewhere. Set backend `ENABLE_PRESENT=true` and restart the local API and workers to exercise the feature against real services. Canvas gates and project Canvas opt-in remain independent.

The Directus metadata alignment script is prepared at `directus/migrations/align_project_language_metadata.py`, but it has not run. Apply it through the normal local migration workflow and pull the generated snapshot before a deployment requiring aligned dropdown metadata. Stored `multi` and null language values are preserved.

The skipped database integration checks need the test PostgreSQL service. Re-run them against PostgreSQL before release; in-memory publication tests do not replace that check. Real authenticated host flows also need the local Directus/Redis/API stack. The browser verification used fixtures, not a connected project.

Projector readability, realistic concurrent viewer load on venue wifi and real-provider translation p50/p95, throughput, failures and cost remain release measurements. Review the new audience translations with native speakers, especially disclosure and data-policy text. The host Lingui catalogs retain existing untranslated entries and English fallback; Map controls also use those catalogs.

Overview's proposed Project setup/inheritance display was not invented during the navigation migration. It still needs an authoritative inventory of the actual precedence rules, as required by the plan. Existing settings remain reachable. Additional saved presentations, custom tool authoring, workflow execution, expanded Monitor queues and global Ask remain deferred as specified.

## UX review corrections

The review pass makes the audience preview the main Present surface, with a compact tab/playback/fullscreen toolbar and responsive editor controls. Tabs are enabled or disabled in the fixed order Popcorn, Tensions, Map, Stakeholders; saved legacy orders are normalized. Portal navigation is labelled Portal editor. Bilingual Popcorn uses a letter-by-letter text transition with no Original/Translation caption and retains the agreed reading intervals, pause/resume and reduced-motion behavior.

Present now uses a persisted host-only draft and a single Publish changes action. Shared settings components route their writes through the draft context; Intro, Data policy, title and Analysis voice use the established autosave hook and SaveStatus. Authenticated draft previews use separate read routes and bypass the published bundle cache. Autosaving does not update the live room, mint a public token or dispatch processing. Publishing applies the draft, increments its revision and nudges the audience. Draft, publish and legacy settings writes share a bounded report-scoped Redis lock; stale revisions are rejected. Preview refreshes retain the mounted deck rather than reloading it on every edit.

Analysis results and Conversations now share EntityListRow, extracted from the existing ConversationRow shell. Result edits retain their explicit immutable publication boundary, labelled Publish revision. Withdraw and rollback use the existing ConfirmModal. Analysis voice no longer duplicates the presentation title.

Verification for this pass: 71 backend tests passed across Present, settings, rendering, translation, language policy and synthetic demos. Focused frontend checks cover the deck bridge, bilingual timing, draft/public URL isolation, serialized draft writes, shared rows, opening autosave and late-save races. TypeScript and the production frontend build pass. A connected local demo check confirmed a new tab appeared only in the saved draft until Publish changes; the original demo tab selection was restored afterwards. The local API was restarted with Present enabled. No schema migration, commit or push was performed.

## Preparing and operating the room

Present now initializes a full presentation and editor before recordings exist. New presentations include a project-title introduction, the project-derived data-processing explanation, and Popcorn as the only result tab. Present opens the published audience destination without running processing. Go live and Share are prominent alongside it; sharing uses the same autosave and Publish changes boundary. Existing presentations retain their choices.

Audience navigation restores underlined tabs at the top, with separate playback/fullscreen controls. Introduction and Data policy are directly accessible and remain usable with no results or selected result tabs. Explicit result-tab navigation leaves an ordinary introduction; synthetic examples retain their initial disclosure flow.

A connected empty-project test exposed a schema mismatch missed by the earlier mocks: project_report has a database-generated bigint ID, not a UUID. Creation now uses that ID, serializes default creation per project, and repairs missing config/loop rows without replacing existing random-UUID rows. An incomplete presentation remains retryable through the authorized default endpoint.

Verification: 53 focused backend tests and 23 frontend tests passed, including numeric IDs, concurrent creation, partial retry, legacy settings preservation, empty-project editor setup, opening screens without result tabs, and no processing on Present. TypeScript passes. The local zero-conversation project “new test” was used to verify introduction, data processing and Popcorn waiting views with real services. No recordings, model runs or schema migrations were created for this check.

## Translation delivery and original presentation chrome

Restored the original Popcorn title, client/date metadata and underlined top tabs. The audience shell owns one SSE subscription and forwards updates through the validated deck bridge. Embedded decks no longer open a second stream. Reconnects reload authoritative state; coalesced reads respect the bundle cache and retain playback. Existing slow recovery reads cover a lost publish and public-access revocation.

Translation completion now persists and publishes each provider batch through the existing writer and report channel. Partial successes remain available when another batch fails. Translation text, target, policy and source identity participate in deck change detection, so completed results accept translations without another analysis revision. Failed translation-only jobs are recorded as errors and can be retried with the same request identity.

The local demo initially had a worker running stale imports. Restarting it and retrying the synthetic translation job populated 113 display-text translations, including all 30 Popcorn items. The browser displays the English translations. A local report-channel event triggered audience and deck reads without changing saved content. Regression checks cover persist-before-publish, partial batch failure, same-revision translation arrival, reconnects, bridge readiness and absence of a duplicate embedded stream.

Validation for this correction: 52 backend tests and all 27 presentation component tests pass, along with TypeScript, JavaScript syntax, formatting and the production frontend build. Local API and tick workers were restarted with the final code.

## One presentation frame

The persistent audience shell owns the entire visual frame across Intro, Data policy, Popcorn, Tensions, Map, Stakeholders and empty states. Disclosure, QR, footer and controls are no longer attached only to the legacy deck's screens. Embedded deck chrome is suppressed; the standalone deck retains its original frame. The existing localized footer strings cross the validated bridge as plain text, preserving status wording without a second translation catalog. Opening navigation reflects the visible opening screen.
