# Frontend docs

Design documents for `dembrane/frontend`: proposals, the specs that detail them, and the decisions made along the way.

| Doc | What it covers |
|---|---|
| [RFC 0001: `@dembrane/ui`](rfcs/0001-dembrane-ui.md) | **Draft.** A design-system package that doubles as a catalog for generated UI, with Zod schemas and a json-render catalog for the portal's cards |
| [RFC 0002: The portal's flow as a static plan](rfcs/0002-portal-flow-as-a-static-plan.md) | **Draft.** `planFromProject()` turns project settings into a plan that `/start` and `/finish` render through the catalog: a first step toward a wizard built from an append-only log |
| [Spec: `@dembrane/ui`](specs/design-system.md) | **Reviewed.** Package layers, API conventions, styling, testing, boundaries, phases |
| [Decisions](decisions/README.md) | ADRs 0001–0004, from the `@dembrane/ui` spec |

## Conventions

- **RFCs** (`rfcs/NNNN-title.md`) propose a larger design: the problem, the proposal, alternatives, success criteria, open questions. Status: Draft → Accepted → Superseded.
- **Specs** (`specs/title.md`) come after an RFC and define it precisely enough to build from: structure, conventions, commands, tests, boundaries.
- **ADRs** (`decisions/NNNN-title.md`) record one decision each, made while specifying or building. The format is in [`decisions/README.md`](decisions/README.md).
- When a later document changes an earlier one, link it from the earlier one.
