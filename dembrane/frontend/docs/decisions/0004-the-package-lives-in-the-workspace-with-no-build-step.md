# 0004 The package lives in the workspace with no build step

**Status.** Proposed (2026-11-10).

**Decision.** `@dembrane/ui` is `dembrane/frontend/packages/ui`, a pnpm workspace package
that the app depends on as `workspace:*`. Its `exports` map points at TypeScript source,
and the app's Vite and `tsc` compile it as if it were app code. There is no `dist/`, no
publishing, no registry and no Changesets. It is not in `dembrane/platform`, which is a
bun workspace.

**Why.** The app (dashboard and participant portal, one Vite build) is the only consumer,
so a package buys a boundary, not reuse. A build step would add a watch process and
stale-output bugs, and would get between an edit and hot reload, all for an artifact
nobody else installs. The platform's toolchain is bun, and running pnpm there breaks its
workspace links, so the frontend's package stays with the frontend's toolchain.

**Best practice followed.** Turborepo calls these "Just-in-Time" internal packages:
packages consumed as source and compiled by the app that imports them.

**Where we deviate.** Granular entry points like Kumo's (`@dembrane/ui/button`) without
the built output Kumo publishes them from. The `exports` map lists source files directly.

**Against.** The package compiles under the app's settings (its `tsconfig`, and the Babel
macros and React Compiler in `vite.config.ts`), so it can't be used by anything outside this Vite app as it
stands, and it can drift into depending on app-only build behaviour. The import bans in
0001 and 0003 keep it from depending on app code. When a second consumer appears (a
marketing site, an embeddable portal), we add a library build then, and this record is
superseded.
