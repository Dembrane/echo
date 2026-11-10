# Spec: `@dembrane/ui` — a design-system package for the frontend

Status: **draft, awaiting review**. Modelled on [Kumo](https://kumo-ui.com/)
(`@cloudflare/kumo`), but keeping Mantine as the engine.

## Objective

Move dembrane's visual language (tokens, theme, primitives, a few composites)
out of `dembrane/frontend/src` into a self-contained workspace package,
`@dembrane/ui`. The app then imports UI the way a Kumo consumer does:

```ts
import { Button, Text, Stack } from "@dembrane/ui";          // barrel
import { Button } from "@dembrane/ui/button";                 // granular
import { roles } from "@dembrane/ui/tokens";
import "@dembrane/ui/styles.css";
```

**Why.** It isn't for reuse: the dashboard and portal app is the only consumer
(decided 2026-11-10). It's for a **boundary**:

- Design decisions live in one place with an API. Today they're spread across
  `colors.ts`, `theme.tsx`, `styles/*.css`, `tailwind.config.js` and
  call-site `className`s.
- Mantine becomes an implementation detail. App code says *what* (a
  `danger` button) and never *how* (`color="red" variant="light"`).
- Every component has a story, a test and documented props, so humans and
  agents can see what exists before they build another one.

**Who uses it:** dembrane frontend engineers and coding agents working in
`dembrane/frontend`.

**What success looks like:** a new screen can be built from `@dembrane/ui`
alone. `@mantine/core` no longer appears in app code. The Storybook shows
every component in light and dark.

### Decisions already made

| Question | Decision |
|---|---|
| Consumers | Just the app, for now. No publishing, no registry, no Changesets. |
| Relation to Mantine | **Wrap and hide.** The package owns all `@mantine/core` usage. App imports are banned by lint and migrated gradually. |
| Docs / preview | Storybook, inside the package. |

## Assumptions (correct these)

1. **Location:** `dembrane/frontend/packages/ui`. `dembrane/frontend` becomes a
   pnpm workspace root (it already has `pnpm-workspace.yaml`, but only for
   settings). It is *not* in `dembrane/platform`, which is bun.
2. **No build step.** The package's `exports` point at TypeScript source
   (`./src/*.tsx`), which the app's Vite and tsc compile. A `dist/` build gets
   added only if a second consumer appears. This keeps HMR and avoids a
   watch process.
3. **Mantine 7 and Tailwind 3 stay at their current versions.** Upgrading
   Mantine 8 or Tailwind 4 is a separate project.
4. **Package internals style with Mantine theme overrides, CSS modules and
   `--app-*` variables, not Tailwind classes.** That way the package doesn't
   depend on the consumer's Tailwind `content` scan. The package *exports* a
   Tailwind preset built from the same tokens, so app-level layout classes
   stay in sync.
5. **No translated strings inside the package.** Lingui stays in the app. Any
   built-in copy (a modal's "Cancel", "Copied") is a required prop, or comes
   from a `UIProvider` `labels` object that the app fills from Lingui.
6. **`@mantine/hooks` stays allowed in app code.** It's behaviour, not visual
   language. `@mantine/dates`, `modals`, `notifications`, `dropzone` and
   `charts` get wrapped like core, but later.
7. **Icons stay Phosphor,** a peer dependency, as in Kumo. `lucide-react` is
   in `package.json` but has no imports, so removing it is a separate cleanup.

## Shape of the package

### Layers (the dependency arrows point down only)

| Layer | Exports | Examples |
|---|---|---|
| `tokens` | Colour scales, semantic roles (light and dark), type scale, spacing, radius, the Tailwind preset | today's `colors.ts` and the type/radius/weight parts of `tailwind.config.js` |
| `theme` | `UIProvider` (wraps `MantineProvider`, `DatesProvider`, `ModalsProvider` and the colour scheme), the Mantine theme, `styles.css` | today's `theme.tsx`, `styles/*.css`, the `index.css` var blocks |
| `primitives` | Thin, typed wrappers, one per Mantine component we use | `Text`, `Title`, `Stack`, `Group`, `Box`, `Button`, `ActionIcon`, `Badge`, `Alert`, `Tooltip`, `Anchor`, `Modal`, `Paper`, `Loader`, `Skeleton`, `TextInput`, `Select`, `Switch`, `Menu`… |
| `components` | Composites built only from primitives | `ConfirmModal`, `CopyIconButton`, `EntityListRow`, `TipBanner`, `ClosableAlert`, `BaseSkeleton`, `UserAvatar`, `Breadcrumbs` |
| `utils` | `cn()`, and a link-adapter provider so components don't import react-router | (like Kumo's `LinkProvider`) |

App-specific code stays in the app: anything that touches auth, routing,
queries, PostHog or Lingui (`Protected`, `LazyRoute`, `FeedbackPortalModal`,
`i18nLink`, and so on).

### API conventions

- **Semantic props, not Mantine props.** `variant: "primary" | "secondary" |
  "ghost" | "danger"`, `size: "sm" | "md" | "lg"`, `tone` for status. A
  primitive's prop type is **our own union**. It never re-exports Mantine's
  `ButtonProps` wholesale. If an escape hatch is needed, it gets a name
  (`unstyled`) and a comment saying why.
- **No colour props.** No `color=` and no `c=`. Colour comes from
  variant and tone, which map to roles. This is the equivalent of Kumo's
  `no-primitive-colors` rule.
- `className` and `style` are passed through, merged with `cn()`, and refs
  are forwarded (React 19 `ref` as a prop).
- Compound components where Mantine has them: `Menu.Item`, `Modal.Title`.
- One file per component, plus a story and a test beside it:

```
packages/ui/src/button/
  Button.tsx
  Button.stories.tsx
  Button.test.tsx
  index.ts            // export { Button, type ButtonProps } from "./Button";
```

### Style example (the target, not final)

```tsx
import { Button as MantineButton } from "@mantine/core";
import type { ReactNode, Ref } from "react";
import { cn } from "../utils/cn";

export type ButtonProps = {
	variant?: "primary" | "secondary" | "ghost" | "danger";
	size?: "sm" | "md" | "lg";
	loading?: boolean;
	disabled?: boolean;
	leftIcon?: ReactNode;
	type?: "button" | "submit";
	onClick?: () => void;
	className?: string;
	ref?: Ref<HTMLButtonElement>;
	children: ReactNode;
};

/** The one action button. Primary is the only pill (see the radius tokens). */
export function Button({ variant = "secondary", size = "md", leftIcon, className, ...rest }: ButtonProps) {
	return (
		<MantineButton
			{...rest}
			data-variant={variant}
			size={size}
			leftSection={leftIcon}
			className={cn("dui-button", className)}
		/>
	);
}
```

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
  src/                       → app code; imports UI only from @dembrane/ui
  packages/ui/
    package.json             → name @dembrane/ui, exports map, peer deps:
                               react, react-dom, @mantine/core, @phosphor-icons/react
    .storybook/              → main.ts (Vite builder), preview.tsx (UIProvider + scheme toggle)
    src/
      tokens/                → colors.ts (moved), type, spacing, radius, tailwind-preset.ts
      theme/                 → UIProvider.tsx, mantine-theme.ts, styles.css
      <component>/           → one folder per primitive or composite
      utils/                 → cn.ts, LinkProvider.tsx
      index.ts               → barrel
    scripts/check-contrast.mjs   → moved from the app
    README.md                → what's in it, the conventions, how to add a component
```

## Testing strategy

- **Unit (Vitest + Testing Library, jsdom)** in the package: each component
  renders inside `UIProvider`. The tests check that variants map to the
  expected `data-` attributes and roles, that props pass through, that refs
  forward, and that keyboard behaviour works where we add any.
- **Stories are the visual spec.** Each component's stories show every variant
  and size, in light and dark. `@storybook/addon-a11y` runs axe on every
  story. A failing axe check fails `test-storybook` in CI.
- **Token checks:** `check-contrast.mjs` keeps running, now from the package.
- **App regression:** the existing app vitest suite and `e2e/grammar` keep
  passing after each migration slice. Each migration PR covers one component
  family, so a regression is easy to find.
- Visual regression (Chromatic or similar) is **out of scope** for v1. The
  plan can revisit it.

## Boundaries

- **Always:**
  - Add new UI to the package with a story and a test.
  - Use roles, never hex values or raw Tailwind palette classes.
  - Keep each migration PR to one component family.
  - Run the app's test suite with `--maxWorkers=2` locally, or on the VM.
- **Ask first:**
  - Adding any dependency (Storybook and its addons included).
  - Changing token values, which is a visual change rather than a refactor.
  - Adding an escape-hatch prop.
  - Wrapping a new Mantine package.
  - Touching CI config.
- **Never:**
  - Import `@mantine/core` from app code once that family is migrated.
  - Put Lingui, react-router, TanStack Query or PostHog imports in
    `packages/ui`.
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
- A package-boundary rule bans imports from `@/` (app aliases) inside
  `packages/ui`.

## Success criteria

1. `@dembrane/ui` exists as a workspace package. The app depends on it with
   `workspace:*`, and both `pnpm build` and `pnpm dev` work with no build step
   for the package.
2. `colors.ts`, `theme.tsx` and the theme CSS live in the package, and the app
   looks pixel-identical before and after. A before/after screenshot check of
   about 5 key screens, light and dark, shows no difference.
3. `grep -r '@mantine/core' dembrane/frontend/src` returns 0 matches, and the
   Biome allowlist is empty.
4. Every exported component has at least one story covering all its variants,
   in both schemes, with no axe violations, plus a unit test.
5. No package file imports `@/`, `@lingui/*`, `react-router`,
   `@tanstack/*` or `posthog-*`, and lint enforces this.
6. `check:contrast` and `check:raw-colours` pass in CI.
7. The package README explains how to add a component in no more than a
   screenful, the way Kumo's AGENTS.md does. The frontend's CLAUDE.md or
   AGENTS.md points to it.

## Proposed phases (to be detailed in the plan)

1. **Scaffold:** set up the workspace, an empty package, Storybook, and the
   lint bans in warn-only or allowlist mode.
2. **Tokens and theme move:** move `colors.ts`, `theme.tsx` and the CSS, add
   `UIProvider`, and have the app switch to it. Pixel-identical.
3. **Primitives:** the high-traffic families first: Text/Title, then
   Stack/Group/Box, then Button/ActionIcon, then Badge/Alert/Tooltip, then
   Modal. Each one is a slice: wrap, write the story and test, migrate the
   call sites, shrink the allowlist.
4. **Composites:** move the generic `components/common` pieces.
5. **Long tail:** the remaining Mantine components, then the other Mantine
   packages, then flip the lint rule to error with an empty allowlist.

## Open questions

1. **Layout primitives:** should we wrap `Stack`/`Group`/`Box` (about 240
   imports), or tell app code to use Tailwind `flex`/`gap` for layout and keep
   the package to "things with visual identity"? Kumo has no
   Stack component. Dropping them would remove a large share of the migration
   work.
2. **Package-internal styling:** I've assumed CSS modules plus variables
   (Assumption 4). The alternative is Tailwind inside the package, with the
   app's `content` scanning `packages/ui/src`. That's simpler today, but it
   couples the package to the app's Tailwind config.
3. **Name:** `@dembrane/ui` shares a scope with the bun platform packages
   (`@dembrane/config`, …). Nothing collides, but would a distinct name like
   `@dembrane/kit` avoid confusion?
4. **The participant portal:** it has its own visual needs (a big record
   button, mobile-first). Should it share all primitives, or does the package
   also hold portal-specific components?
5. **Should the spec be committed?** The other specs at the root are
   git-excluded, and this one is untracked.
