# 0003 The package is styled through the theme layer

**Status.** Proposed (2026-11-10).

**Decision.** Components in `@dembrane/ui` are styled through the theme layer, the way
the app's theme is styled today: Mantine theme overrides (`Component.extend`, as in
`theme.tsx`) drawing only on the `--app-*` role variables (`styles/rules.css`, from the
roles in `colors.ts`), and a CSS module beside the component where an override isn't
enough. There
are no Tailwind classes inside the package. The package exports a Tailwind preset built
from its tokens (`@dembrane/ui/tailwind-preset`), and the app's `tailwind.config.js`
uses it. App-side Tailwind shrinks as screens move to catalog components.

**Why.** The frontend has three styling layers, and only the newest was designed on purpose.
Mantine style props and Tailwind classes at call sites both date from the first commit
(February 2025). The theme layer came on 2026-10-06, in Jorim's design-system pull request
([#1139](https://github.com/Dembrane/echo/pull/1139)): roles in `colors.ts` feeding both
Mantine and Tailwind, `--app-*` variables, the border grammar, and a WCAG AA contrast
check (`scripts/check-contrast.mjs`, which can be run but isn't in CI yet). In the pull
request's words, it is "applied app-wide through the theme and global styles rather than
call sites". It is still current: later changes to it are small, and the call-to-cash
work (`brand/CALL_TO_CASH.md`) treats `rules.css` as the source to carry into PDFs and
email. The package continues that layer. Generated specs (0002) carry no class
strings, so Tailwind would only ever be an internal convenience. Keeping it out also
means the package doesn't depend on the app's Tailwind 3 `content` scan or upgrade
timeline.

**Best practice followed.** Semantic tokens as CSS variables, with component styles
reading roles and never raw values. Kumo does the same with role tokens
(`bg-kumo-elevated`, `text-kumo-subtle`).

**Where we deviate.** Kumo uses Tailwind (v4) inside its components. We don't, because our
theme layer already lives in Mantine overrides and CSS variables, and a second internal
idiom would split it.

**Against.** Moving an existing component means translating its call-site classes and
style props into the theme or a module, which is slower than copying the file. The team
writes Tailwind fluently, and during the migration there are two idioms: the package's
and the app's. The preset keeps both on the same tokens, and `check:raw-colours` fails on
hex values or palette classes outside the tokens.
