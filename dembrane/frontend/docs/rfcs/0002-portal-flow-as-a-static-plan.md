# RFC 0002: The participant portal's flow as a static plan

| | |
|---|---|
| **Status** | Draft |
| **Author** | Patrick Connolly |
| **Created** | 2026-11-12 |
| **Builds on** | `refactor/portal-cleanup` (#1259); [RFC 0001](0001-dembrane-ui.md) (`@dembrane/ui`), its [spec](../specs/design-system.md) and [ADRs 0001–0004](../decisions/README.md) |
| **Related** | `patcon/dembrane-prototypes` → `examples/dembrane/2026-10-23-dembrane-theme` |

## Summary

The participant portal's onboarding (`/start`) and finish (`/finish`) screens stop reading project flags directly. A pure function, `planFromProject(project, lang)`, turns the project's settings into a **plan**: ordered items with triggers, in the same shape as the voice-setup prototype. Those screens render the plan's items through catalog components. Nothing changes for participants or hosts. The point is that the flow becomes data, which is the first step toward a wizard built from an append-only log.

## Motivation

- The portal is already a wizard, but a hard-coded one. About 20 project fields (`default_conversation_tutorial_slug`, `legal_basis`, `default_conversation_ask_for_participant_name`, `default_conversation_finish_text`, `default_conversation_ask_for_participant_email`, `is_project_notification_subscription_allowed`, `is_dembrane_event_cta_enabled`, …) are read across `ParticipantOnboardingCards.tsx`, `ParticipantInitiateForm.tsx` and `ParticipantPostConversation.tsx`. Each new step means new code and a new flag.
- The direction is a dynamic, agentic flow: an append-only log that the plan, the host and an agent all add to, folded into what's on screen (as in `2026-10-23-dembrane-theme`). That needs the flow to be data first.
- `@dembrane/ui` (ADR 0002) makes components serializable so generated specs can assemble them, and the portal is named as the first place this happens. A plan is what tells the portal which of those components to assemble, in what order.
- Half of this is data already. `getSystemCards(lang, tutorialSlug, legalBasis, privacyPolicyUrl, organiserName)` in `src/portal/components/start/onboardingCards.ts` returns slides as objects. Only `icon` and `component` are React, and `component` exists only to put `ParticipantInitiateForm` on the last slide.

## Proposal

### Where it sits

| Layer | Owns | Changed here? |
|---|---|---|
| Engine | routes, queries, the commit (`useInitiateConversationMutation`), the recording and text engines (#1259's `recordingSession` reducer), system overlays, Lingui | no |
| Catalog | serializable components (`@dembrane/ui`, or app-local until it exists) | uses it, and sets the portal's requirements for it |
| **Plan** | which items appear, in what order, under which conditions, bound to which actions | **new** |

### Module: `src/portal/features/plan/`

A vertical slice, laid out as in intent-ui's [modularity standard](https://github.com/Brayden/intent-ui/blob/main/skills/engineering-standards/references/modularity.md). It sits under `src/portal/` rather than `src/features/` (the dashboard's) because the portal has its own entry point and first-load budget.

```
src/portal/features/plan/
  types.ts               Zod schemas and inferred types: Plan, PlanItem, Trigger, Condition, CardSpec, AnswerKey, PlanAction
  lib/
    planFromProject.ts   (project: ParticipantProject, lang: string) => Plan. Pure.
    conditions.ts        isReleased(trigger, ctx). Pure.
    defaultCards.ts      the default json-render card per question type. Pure.
  hooks/
    usePlanSection.ts    released items, the current item, answers in memory, actions bound to the engine
  components/
    PlanSection.tsx      renders one section: `deck` (one item at a time, with Back and Next, as today) or `stack` (every block at once)
    registry.tsx         catalog names → components
    cards/               app-local catalog components until @dembrane/ui has them (each with `@movesTo @dembrane/ui`)
  index.ts               the public surface: planFromProject, PlanSection, the types. The only file other portal code imports.
```

- `lib/planFromProject.ts` is the only portal code that reads the flow flags. Slide text comes from today's `onboardingCards.ts`, unchanged.
- `lib/` never imports React or does I/O. `PlanSection` doesn't fetch: the start and finish routes pass in the project and the engine's actions.
- **Imports:** `components/start` and `routes/ParticipantPostConversation.tsx` import from `features/plan` (its `index.ts`) only. `features/plan` doesn't import from them.
- **Promotion:** card components move into `@dembrane/ui` once the package exists, as part of the change that adds them there. `types.ts` moves into a shared schema (exported as JSON Schema for the Python backend) only when option C needs it.
- **Where intent-ui's standard doesn't apply:** it prefers children and slots over configuration props. Catalog cards follow ADR 0002 instead: serializable props, no `ReactNode` slots. The slots advice only applies to app-only containers such as `PlanSection`.

### Plan shape (a subset of the prototype's `plan.ts`)

```ts
type Plan = { schemaVersion: 1; source: { kind: "project"; projectId: string }; items: PlanItem[]; triggers: Trigger[] };

type ItemBase = { id: string; order: string; parentId?: string; locked?: boolean };
type PlanItem = ItemBase & (
  | { kind: "section"; payload: { display: "deck" | "stack" } }                 // "onboarding", "finish"
  | { kind: "discussion"; payload: { title: string; body: string; icon?: IconName; link?: Link; extraHelp?: string } }
  | { kind: "consent"; payload: { basis: LegalBasis; privacyPolicyUrl?: string; organiserName?: string } } // locked platform card
  | { kind: "prompt"; payload: { key: AnswerKey; question: Question; card?: CardSpec } }
  | { kind: "platform"; payload: { card: "share" | "recordAgain" | "eventCta" } } // locked platform blocks
  | { kind: "action"; payload: { action: PlanAction; label?: string } }
);

type AnswerKey = "name" | "tags" | "email" | "notify";      // where an answer goes (table below)
type PlanAction = "next" | "back" | "commit" | "subscribe" | "recordAgain";

type Condition =
  | { kind: "start" }                                       // the portal opened
  | { kind: "consented" }
  | { kind: "answered"; item: string }
  | { kind: "finished" }                                    // reached /finish (new; not in the prototype)
  | { kind: "any"; of: Condition[] };
type Trigger = { id: string; item: string; when: Condition };
```

The ids, `order` strings and `parentId`s follow the prototype, so items can later be added to a log without renumbering anything.

### What today's flags become

| Today | In the plan |
|---|---|
| `default_conversation_tutorial_slug` (`none`/`basic`/`advanced`) | which `discussion` items go in the `onboarding` section |
| `legal_basis`, `privacy_policy_url`, `organiser_name` | the locked `consent` item's payload, or no item when `getPrivacyCard` returns none |
| `default_conversation_ask_for_participant_name` | a `prompt` with `key: "name"` |
| `project.tags` not empty | a `prompt` with `key: "tags"`, options from `project.tags` |
| the end of the deck | an `action: "commit"` item, released when `consented` |
| `default_conversation_finish_text` | a `discussion` item in `finish` |
| `default_conversation_ask_for_participant_email` | a `prompt` with `key: "email"` in `finish` |
| `is_project_notification_subscription_allowed` | a `prompt` with `key: "notify"` plus `action: "subscribe"` |
| `is_dembrane_event_cta_enabled` | `platform: "eventCta"` |
| QR/share, record another | `platform: "share"`, `platform: "recordAgain"` |

Feature plugin flags (`is_verify_enabled`, `is_verify_on_finish_enabled`, `is_get_reply_enabled`, `is_ai_available`) stay as they are, because they belong to the conversation screen.

### Answers and actions go to today's endpoints

| Key or action | Goes to |
|---|---|
| `name`, `tags` | the `commit` payload: `useInitiateConversationMutation` / `requestConversation` in `ParticipantInitiateForm.tsx` |
| `email`, `notify`, `subscribe` | `useSubmitNotificationParticipant` |
| `consented` | gates `commit`, with today's PostHog consent capture |
| `recordAgain` | today's new-conversation link |

Answer state is in memory (`useState`/`useReducer`), as today.

### What stays exactly as it is

- **Resume and URL behaviour.** `?skipOnboarding=1`, prefilled `name`/`tags`/`tag_id_list` parameters, and the auto-start in `ParticipantInitiateForm`. Refreshing during onboarding restarts the deck, as today. After the commit, the URL and the server are the source of truth, as today. Reopening the portal link starts a new conversation, as today.
- The routes in `src/portal/routes.tsx`, the first-load split (`laterScreens.ts`), and how the host edits settings (`ProjectPortalEditor.tsx` stays a form over the flags).

### What this asks of `@dembrane/ui`

This is the "exact list" the design spec leaves to its plan. The follow-up `@dembrane/ui` RFC takes it on:

- **Primitives used by cards:** `Stack`, `Group`, `Title`, `Text`, `Markdown`, `Button`, `TextInput`, `RadioGroup`, `CheckboxGroup`, `TagPicker`, `Anchor`, and `Icon` by name (the Phosphor registry).
- **Locked portal composites:** `ConsentStep` (legal-basis variants), `OnboardingDeck` (Back, Next, progress), `ShareBlock`, `RecordAgainBlock`, `EventCta`.
- **Card state paths:** `/question` (read) and `/value` (bound), as in the prototype's `cards.ts`, with `/likelihood`, `/dictating` and `/interim` reserved.
- **Callbacks** bind to the `PlanAction` names above.

If the package isn't ready, these live in `src/portal/features/plan/components/cards/` with the same APIs and an `@movesTo @dembrane/ui` note, so neither effort blocks the other.

## Alternatives considered

- **(B) A plan plus a log kept only in the browser.** Postponed, not rejected. It adds resuming during onboarding, a debug log drawer, and tests written as event sequences. Nobody has asked for those yet, and they'd make this step bigger. The appendix describes it so it can be added without rework.
- **(C) A log stored on the server, with agent and host sources.** This is where things are heading, but it's a backend project: a table, endpoints, permissions for anonymous participants, real-time delivery and an agent runner. It gets its own RFC.
- **Storing the plan on the project now.** That needs a backend schema, an editor and a migration of the flags. Building the plan from the flags gives the same shape with none of that.
- **Only pulling the components out, with no plan.** It tidies the code but doesn't move the flow toward data. Turning flags into data is the point of this step.

## Success criteria

1. `lib/planFromProject.ts` is pure and is the only portal code that reads the flow flags listed in "What today's flags become". A grep for those fields in `src/portal/components/start` and `src/portal/routes/ParticipantPostConversation.tsx` finds none.
2. Table tests cover `planFromProject` for every tutorial slug × legal basis (including no privacy card) × ask-for-name × tags present or not × each finish flag. Each case gives the items and order today's screens show.
3. Code outside `src/portal/features/plan/` imports it only through its `index.ts`, and `lib/` imports no React. Lint enforces both, or a test checks them if lint can't.
4. Every plan is JSON. It passes its Zod schema, and `JSON.parse(JSON.stringify(plan))` deep-equals it.
5. The existing tests pass, with changes to selectors only: `ParticipantStart.test.tsx`, `ParticipantOnboardingCards.test.tsx`, `ParticipantInitiateForm.test.tsx`, `DembraneEventCta.test.tsx`, plus `e2e/grammar`.
6. Behaviour is unchanged, each case covered by a test: `skipOnboarding`, prefilled parameters and auto-start, the consent gate on commit, consent captured once, the notification submit, and what a refresh does on each screen.
7. A before-and-after screenshot check of `/start` (each tutorial slug, name and tags shown or not) and `/finish` (all blocks on) finds no visible differences.
8. The portal's first-load budget (`scripts/check-portal-bundle.mjs`) passes, or a raised budget is recorded with the reason.
9. At least one of `/start` or `/finish` is built only from catalog components, with nothing but layout around them. This is design spec criterion 5, and both RFCs share it.

## Out of scope

- B and C (see the appendix): no log, no persistence, no resuming during onboarding, no agent or host sources.
- Steps added mid-conversation. The conversation, refine, verify and explore screens.
- Generation by an LLM, compiling playbooks, schemas for a registry beyond the plan's own Zod types, and storing plans on the project.
- Changes to the host editor (`ProjectPortalEditor.tsx`), or to the backend.
- Changing "reopening the link starts a new conversation".
- Building `@dembrane/ui` itself (that's the follow-up RFC).
- Moving the portal's other screen folders (`components/start`, `finish`, `verify`, `refine`, `conversation`) into `src/portal/features/`. This RFC adds only `features/plan`, and the rest of the portal mixes the two layouts until a separate rename.

## Open questions

- **json-render or a small renderer of our own.** The prototype uses `@json-render/core`/`react`. Adding it is an "ask first" dependency under the design spec, and it counts against the portal's first-load budget.
- **Translations.** This RFC builds the plan for one locale at runtime, from today's per-language texts and Lingui strings, so plans hold plain strings. Plans written by a host or a model will need per-language strings or one plan per language. That's decided when plans stop being built from flags.
- **Which screen is built from the catalog first:** `/finish` (simpler, all at once) or `/start` (the deck, consent, the commit)?
- **Card scope:** should `prompt` items accept a custom `card` now, or only default cards per type until plans are written by someone other than `planFromProject`?

## Appendix: option B, written down but not built

```ts
type Entry = { id: string; at: number; subjectId: string } & (
  | { kind: "released"; item: PlanItem; source: "plan" | "host" | "agent" }
  | { kind: "shown" }
  | { kind: "answer"; value: AnswerValue; skipped?: boolean }
  | { kind: "committed"; conversationId: string }
  | { kind: "status"; status: "recording" | "paused" | "stopped" | "finished" }
);
declare function release(plan: Plan, view: View, event: { kind: "start" | "answer" | "finished" }): Entry[];
declare function foldLog(entries: readonly Entry[]): View; // consented, answersByKey, released queue, current item, conversationId, phase
```

- Entries are only ever added, and for each `subjectId` the latest one wins. The log is stored in `sessionStorage` under `portal-log:<projectId>`, and moves under the `conversationId` after the commit.
- **The server wins after the commit.** The log holds only what the server doesn't have. It never overrides the conversation, chunk or artefact queries.
- The engine stays in charge of its own state (the `recordingSession` reducer). It only adds `status` entries when its state changes.
- A host or agent addition is a `released` entry with `source: "host" | "agent"`. That's the seam option C builds on.
