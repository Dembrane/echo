# RFC 0001: `@dembrane/ui`, a design system that is also a catalog

| | |
|---|---|
| **Status** | Draft |
| **Author** | Patrick Connolly |
| **Created** | 2026-11-12 (written after the spec, which it now precedes) |
| **Detailed in** | [Spec: `@dembrane/ui`](../specs/design-system.md) |
| **Decisions** | [ADRs 0001–0004](../decisions/README.md) |
| **Used by** | [RFC 0002: the portal's flow as a static plan](0002-portal-flow-as-a-static-plan.md) |

## Summary

Move dembrane's visual language (tokens, theme, primitives, composites and the participant portal's pieces) into a workspace package, `@dembrane/ui`, that wraps Mantine behind small, semantic, serializable APIs. It's a design system for the people and agents writing the frontend today. It's also the **catalog** a generated UI will be assembled from, starting with the portal. The components the portal's plan renders get Zod prop schemas and a [json-render](https://github.com/vercel-labs/json-render) catalog now. The rest get theirs later.

## Motivation

- **Styling decisions are made at call sites.** About 470 `@mantine/core` imports, about 2,560 Mantine style props (`c=`, `mt=`, `gap=`) and about 1,350 Tailwind `className`s, with 182 files mixing both. The theme layer from [#1139](https://github.com/Dembrane/echo/pull/1139) (`colors.ts`, `styles/rules.css`, `theme.tsx`) sets the rules, but any call site can override them, and nothing shows which combinations are meant to exist.
- **Generated UI needs a catalog.** The direction is a portal assembled from data: first a plan built from project settings ([RFC 0002](0002-portal-flow-as-a-static-plan.md)), later an append-only log that a host and an agent add to (`patcon/dembrane-prototypes` → `2026-10-23-dembrane-theme`). A plan or a model can only choose from components that are few, semantic (`variant: "danger"`, not 40 Mantine props) and writable in JSON.
- **The same properties help people now.** One place to look, one API per thing, and a story for every component.
- **Why now:** RFC 0002 is the first consumer that renders components from data, and it needs a handful of them to be serializable, with schemas.

## Proposal

The [spec](../specs/design-system.md) has the detail. This is its outline, plus what RFC 0002 adds.

### The package

- `dembrane/frontend/packages/ui`, a pnpm workspace package the app depends on as `workspace:*`. Its `exports` point at TypeScript source, so there's no build step (ADR 0004).
- Layers, with dependencies pointing down only: `tokens` → `theme` (`UIProvider`, the Mantine theme, `styles.css`) → `icons` (Phosphor, referred to by name) → `primitives` (one thin wrapper per Mantine component) → `components` (composites) → `portal` (participant-facing pieces) → `catalog` (new: schemas and the json-render catalog, below).
- **Mantine is wrapped and hidden** (ADR 0001). The package owns every `@mantine/core` import, and Biome bans it in the app using an allowlist that only shrinks.
- **Styled through the theme layer** (ADR 0003): `Component.extend` overrides and `--app-*` role variables, with CSS modules where needed. There's no Tailwind inside the package, and it exports a Tailwind preset for the app.
- **No app concerns inside it:** no Lingui, react-router, TanStack Query or PostHog. Copy is passed in as string props or through `UIProvider` labels.

### Catalog vs app-only (ADR 0002)

Every export is one of two kinds:
- **Catalog** (the default). Props are strings, numbers, booleans, string unions, and plain objects or arrays of those, plus `children`, named callbacks, `ref` and `className`/`style`.
- **App-only.** It needs a `ReactNode` body or a render prop, and it's marked `/** @appOnly <reason> */`.

### What RFC 0002 adds: schemas and a json-render catalog for the portal's cards

The spec put schemas, a registry and a renderer out of scope. This RFC brings in **one slice** of that work: the components RFC 0002's cards render.

| Kind | Components |
|---|---|
| Primitives | `Stack`, `Group`, `Title`, `Text`, `Markdown`, `Button`, `TextInput`, `RadioGroup`, `CheckboxGroup`, `TagPicker`, `Anchor`, `Icon` |
| Locked portal composites | `ConsentStep` (legal-basis variants), `OnboardingDeck`, `ShareBlock`, `RecordAgainBlock`, `EventCta` |

- **The schema is the source of the type.** Each of these components has a `<Name>.schema.ts` beside it exporting a Zod object. Its props type is `z.infer` of that, plus the allowed non-serializable extras (callbacks, `ref`, `className`). The schema and the type can't drift apart.
- **Schema conventions,** as in json-render's own catalogs and the prototype's `cards.ts`:
  - Optional props are **nullable rather than optional**, so a model always says what it means.
  - Each prop has a `.describe()`.
  - State bindings (`$state`, `$bindState`) accept only the paths a card may use: `/question` and `/value` now; `/likelihood`, `/dictating` and `/interim` reserved.
- **Catalog and registry live in the package:** `@dembrane/ui/catalog` exports `portalCatalog` (`defineCatalog` from `@json-render/core`), plus a registry that maps its names to the components. Both are free of app concerns. The app binds actions (`next`, `commit`, …) when it renders.
- **Everything else keeps the convention only.** Other catalog components get no schema yet. Each gets a schema when something renders it from data, in the change that does so.
- **Serializability check:** each catalog component still has a story whose args are parsed from a JSON string. Each schema'd component also has a test that its JSON-args story passes `schema.parse`.

### New dependencies (the spec's "ask first", asked here)

- `@json-render/core` and `@json-render/react` (0.22). They count against the portal's first-load budget, which RFC 0002 checks.
- **Zod 4:** json-render needs `zod@^4`. The app has `zod@^3.24.2` in 4 files, and Zod 4 is already in the lockfile as a transitive dependency. The plan is to move the app to Zod 4. The fallback is that the package depends on Zod 4 alone.
- **React 19.2:** `@json-render/react` needs `react@^19.2.3`, and the app resolves `19.0.0`. That's a minor bump.
- Storybook and its addons (already in the spec, approved here).

### Phases

The spec's phases, with schemas added to phase 4:

1. **Scaffold:** the workspace, an empty package, Storybook, and the lint bans in allowlist mode.
2. **Tokens and theme move,** pixel-identical.
3. **Primitives,** family by family, starting with those RFC 0002 needs.
4. **Portal and catalog:** the locked portal composites, the schemas and `portalCatalog` for the components above, and one portal screen built from the catalog alone (shared with RFC 0002).
5. **Composites** from `components/common`, with app-only ones marked.
6. **Long tail:** the rest of Mantine, the other Mantine packages, and flipping the lint rule to error.

## Alternatives considered

- **Use Mantine directly, with conventions.** No wrapper code, but nothing enforces the rules, and Mantine's prop surface is too big for a model to choose from. Rejected in ADR 0001.
- **Adopt Kumo itself.** It's the model we follow, but it's built on Base UI and Tailwind 4. Switching engines and redoing the theme layer is a rewrite, not a migration.
- **Tailwind inside the package.** The team knows it, but generated specs carry no class strings, and the theme layer already lives in Mantine overrides and CSS variables. Rejected in ADR 0003.
- **A built, published package.** There's only one consumer, so a build step only adds stale-output bugs. Rejected in ADR 0004 until a second consumer appears.
- **Schemas for every component now.** That's a lot of work before anything renders them, and the schemas would be guesses. Rejected: schemas arrive with their first consumer.
- **A small renderer of our own instead of json-render,** to keep schemas later. It would be thrown away once json-render arrives, and it would split from the prototype. Rejected on 2026-11-12.

## Success criteria

From the spec, condensed:
1. `@dembrane/ui` is a workspace package. `pnpm build` and `pnpm dev` work with no build step for it.
2. Tokens, theme and CSS live in the package, and the app uses its Tailwind preset. A before-and-after screenshot check of about 5 screens, light and dark, shows no difference.
3. `grep -r '@mantine/core' dembrane/frontend/src` returns nothing, and the Biome allowlist is empty.
4. Every component has a unit test and stories for all its variants, in both colour schemes, with no axe violations. Every catalog component has a JSON-args story, and every app-only one has an `@appOnly` reason.
5. No package file has Tailwind classes or imports `@/`, `@lingui/*`, `react-router`, `@tanstack/*` or `posthog-*`. Lint enforces this.
6. `check:contrast` and `check:raw-colours` run in CI and pass.
7. The package README explains how to add a component and the catalog-vs-app-only rule, in one screenful.

Added by this RFC:

8. Every component in the table above has a `.schema.ts`, and its props type is derived from it. Its JSON-args story passes `schema.parse`.
9. `portalCatalog` validates every card RFC 0002's `planFromProject` produces (`validateSpec`), across RFC 0002's table of flag combinations.
10. One portal screen is built only from catalog components, rendered from a plan through `portalCatalog`. This is shared with RFC 0002.

## Out of scope

- Schemas for components no plan renders yet, a registry beyond `portalCatalog`, and generation by an LLM.
- Mantine 8 and Tailwind 4.
- Visual regression tooling such as Chromatic.
- Publishing, or a `dist/` build.

## Open questions

- **Zod 4 everywhere, or only in the package?** Moving the app's 4 files is small, but it's a separate change.
- **Phase order:** should phase 4 (portal and catalog) start once the primitives RFC 0002 needs exist, ahead of the rest of phase 3? That way RFC 0002 isn't waiting on the whole dashboard migration.
- **Locked composites as catalog entries:** `ConsentStep` and its siblings take serializable props, but a plan can only place them, not configure them freely. Should the catalog mark them `locked`, as the prototype's platform cards are, or does that belong in RFC 0002's plan schema?

## Related documents

- [Spec: `@dembrane/ui`](../specs/design-system.md): the detailed definition. Where this RFC adds to it (schemas and `portalCatalog` in phase 4), this RFC wins.
- [ADRs 0001–0004](../decisions/README.md)
- [RFC 0002](0002-portal-flow-as-a-static-plan.md): the first consumer
