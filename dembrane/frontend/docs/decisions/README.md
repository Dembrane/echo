# Decisions

One file per decision about the frontend: what we chose, the best practice it follows,
where we deviate, and the strongest case against it. Superseded records stay, marked
superseded.

| # | Decision | Status |
|---|---|---|
| [0001](0001-mantine-is-wrapped-and-hidden.md) | Mantine is wrapped and hidden | Proposed |
| [0002](0002-the-package-is-a-catalog-with-serializable-props.md) | The package is a catalog with serializable props | Proposed |
| [0003](0003-the-package-is-styled-through-the-theme-layer.md) | The package is styled through the theme layer | Proposed |
| [0004](0004-the-package-lives-in-the-workspace-with-no-build-step.md) | The package lives in the workspace with no build step | Proposed |

0001–0004 come from `SPEC-design-system.md` (the `@dembrane/ui` design system).

The frontend's older comments cite `ADR-0003` ("external as a first-class workspace
role"). That is a different series, `echo/docs/adr/`, deleted on 2026-09-28; read it with
`git show "ed1d6baa0^:echo/docs/adr/0003-external-as-role.md"`.
