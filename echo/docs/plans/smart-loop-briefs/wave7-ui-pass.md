# Brief: Wave 7 - UI pass over every SMART-loop surface

Owner request: a proper UI polish pass. The features work; now they must FEEL like
dembrane. Binding rules (read all three before touching anything):
`echo/frontend/AGENTS.md` (type ramp table, dynamic theming, button/color rules),
`echo/AGENTS.md` "UI Rules" + "Brand & UI Copy", and the D17 design principles in
`echo/docs/plans/smart-loop.md` (approachable, human, empathetic first; nothing
generic). Look at neighboring polished surfaces for register: LiveMonitorSection,
ProjectSettingsSection usage, the reports list.

## Surfaces to pass (work through ALL of them, screenshot before/after each)

1. Library route (`routes/project/library/LibraryRoute.tsx`): row rhythm and hierarchy
   (name vs status vs last-updated must use non-adjacent ramp steps), hover/click
   affordance, the empty state (should feel warm, not like an error), loading
   skeletons rather than spinners where the list is expected.
2. Canvas page (`routes/project/canvas/CanvasRoute.tsx`): header hierarchy (title /
   status line / controls), the version strip (chips: quiet, scannable, selected state
   obvious, "back to live" affordance clear), Pause-Resume + Refresh now placement and
   weight (subtle, not competing with the canvas itself), full-screen affordance, the
   stale/"preparing" states.
3. Proposal cards - CanvasSuggestionCard, GoalSuggestionCard,
   (and eyeball ProjectUpdateSuggestionCard/CustomVerificationTopicSuggestionCard for
   consistency): KNOWN VIOLATIONS to fix everywhere - hardcoded `border-slate-200`
   family borders (GoalSuggestionCard:50,67; CanvasSuggestionCard:97,119;
   ProjectGoalSection:183; WorkspaceMethodologiesSection:201). Use theme-consistent
   treatment (Paper + the app's border tokens / var(--app-*) styling, matching how
   polished chat cards do it). Cards should share one visual family: same paddings,
   same title treatment, same action row.
4. Composer (AgenticChatPanel): the new separate Stop control - deliberate but
   discoverable (icon-only ActionIcon with tooltip per the 6g design); confirm the
   in-flight state reads clearly (who is doing what right now); appended-message
   feedback ("will be answered next") must be visible and calm.
5. Methodology surfaces: project-settings selector (framing text placement/size),
   workspace Methodologies card (list rhythm, built-in badge for dembrane, modals:
   field spacing, sentence-case labels, primary/subtle button pairing per
   ConfirmModal conventions).
6. ProjectGoalSection: current-goal presentation (goal text should read as the
   PRIMARY content, provenance line quiet), revision history expand (the border-l
   slate fix), edit mode affordances.
7. Setup-chat entry: the seeded first exchange - check nothing looks broken while the
   first turn streams (empty-thread + working state).

## Rules that WILL be checked in review

- No `variant="default"`, no `color="blue"`, no `c="dimmed"` in new code, no hardcoded
  hex/slate/gray classes for chrome - Mantine tokens, theme CSS vars, or the ramp
  classes only.
- Type ramp: no adjacent steps stacked (15px over 12px is the named violation);
  no `text-[Npx]`, `fz={N}`, `fontSize:`.
- Buttons: omit variant (filled primary) for the one primary action; outline/subtle
  for the rest; text labels over icon-only for important actions (Stop is the agreed
  exception - icon + tooltip).
- Copy: sentence case, lowercase dembrane, never "AI", never "successfully", short and
  human. Every string through lingui; run extract+compile after changes.
- Spacing: follow the neighbors (Stack gaps used in ProjectSettingsSection contexts).
- Do not change behavior - visual/copy only. If a behavior change seems needed, report
  it instead.

## QA

- Playwright against the dev server (fixtures fine): before/after screenshots per
  surface to wave7-shots/ (no git-add), and describe the concrete changes per surface
  in the report.
- Gates: tsc, biome lint, lingui extract+compile. If you touch shared components,
  eyeball their other call sites for regressions and say which you checked.
- No git write commands. Report -> echo/docs/plans/smart-loop-briefs/wave7-REPORT.md.
