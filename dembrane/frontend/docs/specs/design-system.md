# Spec: `@dembrane/ui`, the design system and component catalog

Status: **reviewed. The open questions were settled in an interview on 2026-11-10.**
Proposed by [RFC 0001](../rfcs/0001-dembrane-ui.md). The decisions behind it are [ADRs 0001–0004](../decisions/README.md).
Modelled on [Kumo](https://kumo-ui.com/) (`@cloudflare/kumo`), but keeping
Mantine as the engine.

## Objective

Move dembrane's visual language (tokens, theme, primitives, composites,
participant portal pieces) out of `dembrane/frontend/src` into a
self-contained workspace package, `@dembrane/ui`. The app imports UI the way
a Kumo consumer does:

```ts
import { Button, Text, Stack } from "@dembrane/ui";          // barrel
import { Button } from "@dembrane/ui/button";                 // granular
import { roles } from "@dembrane/ui/tokens";
import uiPreset from "@dembrane/ui/tailwind-preset";
import "@dembrane/ui/styles.css";
```

**Why.** The package is a **catalog of components to assemble**. It's
groundwork for generative UI: in the future, an LLM will emit a JSON spec,
the app will render it with something like
[json-render](https://github.com/vercel-labs/json-render) or
[intent-ui](https://intent-ui.com/), and the participant portal will be the
first place that happens. A model can only assemble from a catalog that is:

- **Small and constrained.** It picks `variant: "danger"`. It can't
  reason about Mantine's 40-prop surface or Tailwind class strings.
- **Serializable.** Every prop can be written in JSON.
- **Complete.** Layout, text, controls and portal steps are all in it, so a
  screen can be built from the catalog alone.

The same properties help humans and coding agents today. There's one place
to look, one API per thing, and a story for every component.

**Who uses it:**
- Now: dembrane frontend engineers and coding agents working in
  `dembrane/frontend`.
- Later: an LLM emitting UI specs.
- The app is the only code consumer. There is no publishing.

**What success looks like:** a dashboard or portal screen can be built from
catalog components alone. `@mantine/core` no longer appears in app code.
When schemas are needed, adding them is purely additive and changes no
component APIs.

### Decisions

| Question | Decision |
|---|---|
| Consumers | The app only, for now. No publishing, no registry, no Changesets. |
| Relation to Mantine | **Wrap and hide.** The package owns all `@mantine/core` usage. App imports are banned by lint and migrated gradually. |
| Docs / preview | Storybook, inside the package. |
| Purpose | A design system **and** a catalog for future LLM-generated UI rendered from JSON specs. |
| Layout | **Wrapped.** `Stack`/`Group` are catalog primitives with token-based gaps. `Box` is dropped in favour of plain elements. |
| Props | **Serializable by default** (see API conventions). Pieces too complex for that are marked *app-only* and kept out of the catalog. |
| Portal | Portal components live in the package. The portal is the first target for generated UI. |
| Styling inside the package | **Follows the theme layer:** Mantine theme overrides (as in `theme.tsx`), `--app-*` variables (`rules.css`, from the roles in `colors.ts`), and CSS modules where an override isn't enough. No Tailwind inside the package. |
| Name | `@dembrane/ui` |
| Commit the spec? | Yes, in `dembrane/frontend/docs/specs/`, beside `rfcs/` and `decisions/` (settled 2026-11-12). |

The reasoning for the first four decisions is in
[`docs/decisions/0001`–`0004`](../decisions/README.md).

## Background: how the frontend is styled today

There are three layers. Only the newest one was designed on purpose.

| Layer | Extent | Since |
|---|---|---|
| Mantine style props at call sites (`c=`, `mt=`, `gap=`, `fz=`…) | ~2,560 uses | initial commit (Feb 2025) |
| Tailwind classes at call sites | ~1,350 `className=`. 182 files mix both layers. | initial commit |
| Theme layer: `--app-*` variables (`styles/rules.css`), roles in `colors.ts` feeding both Mantine and Tailwind, overrides in `theme.tsx`, the border grammar, a WCAG AA contrast check (`scripts/check-contrast.mjs`, which can be run but isn't in CI) | global | 2026-10-06, Jorim's design-system pull request ([#1139](https://github.com/Dembrane/echo/pull/1139)), still current |

There are also 21 CSS modules, added one at a time. The package continues
the theme layer. Both kinds of call-site styling are what the catalog absorbs.

## Assumptions

1. **Location:** `dembrane/frontend/packages/ui`. `dembrane/frontend` becomes a
   pnpm workspace root. It already has `pnpm-workspace.yaml`, but only for
   settings. It is *not* in `dembrane/platform`, which is bun.
2. **No build step.** The package's `exports` point at TypeScript source,
   which the app's Vite and tsc compile. A `dist/` build gets added only if a
   second consumer appears.
3. **Mantine 7 and Tailwind 3 stay at their current versions.** Upgrading
   either is a separate project.
4. **No translated strings inside the package.** Lingui stays in the app.
   Built-in copy ("Cancel", "Copied") is a required string prop, or comes from
   a `UIProvider` `labels` object that the app fills from Lingui. Strings are
   serializable, so they work either way.
5. **`@mantine/hooks` stays allowed in app code.** It's behaviour, not visual
   language. `@mantine/dates`, `modals`, `notifications`, `dropzone` and
   `charts` get wrapped like core, but later.
6. **Icons are Phosphor,** as a peer dependency. The catalog refers to them
   **by name** through an icon registry in the package. `lucide-react` is
   installed but never imported, so removing it is a separate cleanup.

## Shape of the package

### Layers (the dependency arrows point down only)

| Layer | Exports | Examples |
|---|---|---|
| `tokens` | Colour scales, semantic roles (light and dark), type scale, spacing, radius, and the Tailwind preset built from them | today's `colors.ts` and the type/radius/weight parts of `tailwind.config.js` |
| `theme` | `UIProvider` (wraps `MantineProvider`, `DatesProvider`, `ModalsProvider` and the colour scheme), the Mantine theme, `styles.css` | today's `theme.tsx`, `styles/*.css`, the `index.css` variable blocks |
| `icons` | The icon registry: names mapped to Phosphor components | `"copy"`, `"warning"`, `"microphone"` |
| `primitives` | Thin, typed wrappers, one per Mantine component we use | `Text`, `Title`, `Stack`, `Group`, `Button`, `ActionIcon`, `Badge`, `Alert`, `Tooltip`, `Anchor`, `Modal`, `Paper`, `Loader`, `Skeleton`, `TextInput`, `Select`, `Switch`, `Menu`… |
| `components` | Composites built only from primitives | `ConfirmModal`, `CopyIconButton`, `EntityListRow`, `TipBanner`, `ClosableAlert`, `UserAvatar`, `Breadcrumbs` |
| `portal` | Participant-facing pieces built from primitives | the record button, consent step, prompt card, verify step (exact list in the plan) |
| `utils` | `cn()`, and a `LinkProvider` so components never import react-router | |

App-specific code stays in the app: anything that touches auth, routing,
queries, PostHog or Lingui (`Protected`, `LazyRoute`, `FeedbackPortalModal`,
`i18nLink`, and so on). That includes the data-fetching shells around portal
components.

### Catalog vs app-only

Every export is one of two kinds:

- **Catalog** (the default): it follows the serializable-props rule below, and
  could appear in a generated spec.
- **App-only**: it needs something JSON can't express, such as an
  arbitrary `ReactNode` body or a render prop. It's marked with
  `/** @appOnly <reason> */` in its file and tagged `app-only` in its
  story, so a future registry can leave it out mechanically.

### API conventions

- **Serializable props.** Props are strings, numbers, booleans, string-literal
  unions, and plain objects or arrays of those. These are allowed as
  exceptions:
  - `children`
  - named event callbacks (`onClick`, `onChange`, `onConfirm`), which a
    renderer binds to actions
  - `ref`
  - `className`/`style` passthrough, as the app's escape hatch, never part
    of a spec

  There are no other `ReactNode` props, no render props, and no component
  props. An icon is `icon="copy"`, not `leftIcon={<Copy />}`.
- **Semantic props, not Mantine props.** `variant: "primary" | "secondary" |
  "ghost" | "danger"`, `size: "sm" | "md" | "lg"`, `tone` for status. A
  component's prop type is **our own type**. It never re-exports Mantine's
  props wholesale.
- **No colour props.** No `color=` and no `c=`. Colour comes from variant and
  tone, which map to roles.
- **Layout through primitives.** `Stack`/`Group` take `gap: "xs" | "sm" |
  "md" | "lg" | "xl"`, mapped to spacing tokens. Arbitrary numbers aren't
  accepted.
- Compound components where Mantine has them (`Menu.Item`, `Modal.Title`).
  Each part also follows the serializable rule.
- Refs are forwarded (in React 19, `ref` is a prop), and `className` is merged
  with `cn()`.
- One folder per component, with the story, test and CSS module beside it:

```
packages/ui/src/button/
  Button.tsx
  Button.module.css   // only if a theme override isn't enough
  Button.stories.tsx
  Button.test.tsx
  index.ts            // export { Button, type ButtonProps } from "./Button";
```

### Styling inside the package

- Mantine components are styled through **theme overrides**: `Component.extend`
  in the package theme, as `theme.tsx` does today. Overrides draw on the
  `--app-*` role variables only.
- When an override isn't enough, the component gets a **CSS module** that
  uses the same variables.
- **No Tailwind classes in `packages/ui`.** Tailwind is the app's tool. The
  package exports `@dembrane/ui/tailwind-preset`, built from the tokens, so
  the app's remaining layout classes resolve to the same values. The app's
  `tailwind.config.js` becomes `presets: [uiPreset]` plus its own `content`
  paths.
- Moving an existing component means translating its call-site Tailwind
  classes and Mantine style props into the theme or a module. That's slower
  than copying the file, and it's the point of the exercise.

### Style example (the target, not final)

```tsx
import { Button as MantineButton } from "@mantine/core";
import type { Ref } from "react";
import { Icon, type IconName } from "../icons";
import { cn } from "../utils/cn";

export type ButtonProps = {
	variant?: "primary" | "secondary" | "ghost" | "danger";
	size?: "sm" | "md" | "lg";
	icon?: IconName;
	loading?: boolean;
	disabled?: boolean;
	type?: "button" | "submit";
	onClick?: () => void;
	className?: string;
	ref?: Ref<HTMLButtonElement>;
	children: string;
};

/** The one action button. Primary is the only pill (see the radius tokens). */
export function Button({ variant = "secondary", size = "md", icon, className, ...rest }: ButtonProps) {
	return (
		<MantineButton
			{...rest}
			data-variant={variant}
			size={size}
			leftSection={icon ? <Icon name={icon} /> : undefined}
			className={cn(className)}
		/>
	);
}
```

`data-variant` is what the theme override in `theme/mantine-theme.ts` keys
on.

## Commands

Run from `dembrane/frontend`. Don't run `pnpm format`: it rewrites the whole repo.

```
Install:     pnpm install
Dev (app):   pnpm dev
Storybook:   pnpm --filter @dembrane/ui storybook            # port 6006
Build SB:    pnpm --filter @dembrane/ui build-storybook
Test (ui):   pnpm --filter @dembrane/ui test --run --maxWorkers=2
Test (app):  pnpm test --run --maxWorkers=2
Typecheck:   pnpm build                                     # tsc && vite build
Lint:        pnpm lint
Contrast:    pnpm --filter @dembrane/ui check:contrast       # moved from the app
Raw colours: pnpm check:raw-colours                         # new; see Boundaries
```

## Project structure

```
dembrane/frontend/
  pnpm-workspace.yaml        → gains `packages: ["packages/*"]`
  package.json               → app; depends on "@dembrane/ui": "workspace:*"
  tailwind.config.js         → presets: [uiPreset]
  src/                       → app code; imports UI only from @dembrane/ui
  packages/ui/
    package.json             → name @dembrane/ui, exports map, peer deps:
                               react, react-dom, @mantine/core, @phosphor-icons/react
    .storybook/              → main.ts (Vite builder), preview.tsx (UIProvider + scheme toggle)
    src/
      tokens/                → colors.ts (moved), type, spacing, radius, tailwind-preset.ts
      theme/                 → UIProvider.tsx, mantine-theme.ts, styles.css
      icons/                 → registry.ts, Icon.tsx
      <component>/           → one folder per primitive or composite
      portal/<component>/    → participant-facing pieces
      utils/                 → cn.ts, LinkProvider.tsx
      index.ts               → barrel
    scripts/check-contrast.mjs   → moved from the app
    README.md                → what's in it, catalog vs app-only, how to add a component
```

## Testing strategy

- **Unit (Vitest + Testing Library, jsdom)** in the package: each component
  renders inside `UIProvider`. The tests check that variants map to the
  expected `data-` attributes and roles, that props pass through, that refs
  forward, and that keyboard behaviour works where we add any.
- **Stories are the visual spec.** Each component's stories show every variant
  and size, in light and dark. `@storybook/addon-a11y` runs axe on every story,
  and a failing axe check fails `test-storybook` in CI.
- **Serializability:** each catalog component has one story whose `args` are
  a literal parsed from a JSON string. This proves the props can be written
  in JSON, without needing a schema yet.
- **Token checks:** `check-contrast.mjs` keeps running, now from the package.
- **App regression:** the existing app vitest suite and `e2e/grammar` keep
  passing after each migration slice. Each migration PR covers one component
  family.
- Visual regression (Chromatic or similar) is **out of scope** for now.

## Boundaries

- **Always:**
  - Add new UI to the package with a story and a test.
  - Use serializable props, or mark the component `@appOnly` with a reason.
  - Use roles, never hex values or raw Tailwind palette classes.
  - Keep each migration PR to one component family.
  - Run the app's test suite with `--maxWorkers=2` locally, or on the VM.
- **Ask first:**
  - Adding any dependency (Storybook and its addons included).
  - Changing token values, which is a visual change rather than a refactor.
  - Adding a non-serializable prop to a catalog component.
  - Wrapping a new Mantine package.
  - Touching CI config.
- **Never:**
  - Import `@mantine/core` from app code once that family is migrated.
  - Put Tailwind classes, Lingui, react-router, TanStack Query or PostHog
    imports in `packages/ui`.
  - Change appearance in the same PR that moves a component. A move must be
    pixel-identical.
  - Run `pnpm format`.

**Enforcement:**
- Biome `noRestrictedImports` bans `@mantine/core` in `src/**`, with
  per-file `overrides` as the allowlist for files not yet migrated. The
  allowlist only shrinks.
- A small `check:raw-colours` script fails on hex values or palette classes
  like `bg-gray-500` outside `packages/ui/src/tokens`. There are about 16 such
  uses today, and they get burned down.
- Package-boundary rules ban imports from `@/` (app aliases), `@lingui/*`,
  `react-router`, `@tanstack/*` and `posthog-*` inside `packages/ui`.

## Success criteria

1. `@dembrane/ui` exists as a workspace package. The app depends on it with
   `workspace:*`, and both `pnpm build` and `pnpm dev` work with no build step
   for the package.
2. Tokens, theme and theme CSS live in the package, and the app's
   `tailwind.config.js` uses the package preset. The app looks
   pixel-identical before and after. A before/after screenshot check of about
   5 key screens (dashboard and portal), light and dark, shows no
   difference.
3. `grep -r '@mantine/core' dembrane/frontend/src` returns 0 matches, and the
   Biome allowlist is empty.
4. Every exported component has a unit test and stories covering all its
   variants, in both schemes, with no axe violations. Every catalog component
   also has a JSON-args story. Every app-only component has an `@appOnly`
   reason.
5. One participant portal screen is built entirely from catalog components,
   with nothing but layout around them. This is the proof that the catalog
   can be assembled.
6. No package file contains Tailwind classes or imports `@/`, `@lingui/*`,
   `react-router`, `@tanstack/*` or `posthog-*`, and lint enforces this.
7. `check:contrast` and `check:raw-colours` run in CI and pass. Neither runs in CI
   today: the contrast check exists but isn't wired in, and the raw-colour check is
   new.
8. The package README explains how to add a component, and the
   catalog-vs-app-only rule, in no more than a screenful. The frontend's
   CLAUDE.md or AGENTS.md points to it.

## Proposed phases (to be detailed in the plan)

1. **Scaffold:** set up the workspace, an empty package, Storybook, and the
   lint bans in allowlist mode.
2. **Tokens and theme move:** move `colors.ts`, `theme.tsx` and the CSS, add
   `UIProvider` and the Tailwind preset, and have the app switch to them.
   Pixel-identical.
3. **Primitives:** the high-traffic families first: Text/Title, then
   Stack/Group (and removing Box), then Button/ActionIcon with the icon
   registry, then Badge/Alert/Tooltip, then Modal. Each one is a slice: wrap,
   write the story and test, migrate the call sites, shrink the allowlist.
4. **Portal:** move the participant-facing pieces and build one portal screen
   from the catalog alone (success criterion 5).
5. **Composites:** move the generic `components/common` pieces, marking
   app-only ones.
6. **Long tail:** the remaining Mantine components, then the other Mantine
   packages, then flip the lint rule to error with an empty allowlist.

## Out of scope (for now)

- Zod or JSON schemas for component props, a component registry, a JSON-spec
  renderer, and LLM generation itself. These are the next project, and this
  one keeps them cheap.
- Tailwind 4 and Mantine 8 upgrades.
- Visual regression tooling.
- Publishing to npm, and a `dist/` build.

## Open questions

- None. (Where this spec lives was settled on 2026-11-12: in
  `dembrane/frontend/docs/specs/`, beside `rfcs/` and `decisions/`, and committed.)
