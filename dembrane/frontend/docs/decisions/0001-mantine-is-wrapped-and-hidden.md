# 0001 Mantine is wrapped and hidden

**Status.** Proposed (2026-11-10).

**Decision.** `@dembrane/ui` owns every `@mantine/core` import. App code imports
components only from the package, and the package's own prop types are the only API
it sees: `variant`, `size`, `tone`, `gap` from small unions, with no colour props and no
re-exported Mantine props. Biome's `noRestrictedImports` bans `@mantine/core` in `src/**`,
with a per-file allowlist for code not yet migrated. The allowlist only shrinks. The other
Mantine packages (`dates`, `modals`, `notifications`, `dropzone`, `charts`) follow later
the same way.

**Why.** Styling decisions are made at call sites today: about 470 imports from
`@mantine/core`, about 2,560 Mantine style props (`c=`, `mt=`, `gap=`, `fz=`) and 1,350
Tailwind `className`s, with 182 files mixing both. The theme layer (`colors.ts`, `rules.css`, `theme.tsx`) set the rules,
but any call site can override them, and nothing shows which combinations are meant to
exist. A wrapper is the one place a decision such as "destructive actions are a filled
red button" can live and be enforced.

**Best practice followed.** A facade over a third-party library, as Kumo
(`@cloudflare/kumo`) does over Base UI: consumers depend on our interface, so the
library underneath can be configured, upgraded or swapped in one place.

**Where we deviate.** `@mantine/hooks` stays allowed in app code (115 imports). Hooks are
behaviour, not visual language, and wrapping them would buy nothing.

**Rules.** A move is pixel-identical: a pull request that moves a component does not
change how it looks. Each migration pull request covers one component family. A prop
that exposes Mantine directly (an escape hatch) needs a name, a comment saying why, and
a review.

**Against.** A wrapper for every component we use is code to maintain, and roughly 470
imports migrate before the ban can be strict. Reaching for a Mantine feature now means
wrapping it first, which slows one-off work. If the wrappers prove not worth it, they are
thin: replacing `@dembrane/ui` imports with Mantine ones again is mechanical.
