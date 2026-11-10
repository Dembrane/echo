# 0002 The package is a catalog with serializable props

**Status.** Proposed (2026-11-10).

**Decision.** Every export of `@dembrane/ui` is one of two kinds:

- **Catalog** (the default). Its props are strings, numbers, booleans, string-literal
  unions, and plain objects or arrays of those. The only exceptions are `children`,
  named event callbacks (`onClick`, `onChange`, `onConfirm`), `ref`, and
  `className`/`style` as the app's escape hatch, never part of a spec. Icons are names
  (`icon="copy"`) resolved through the package's icon registry, not elements.
- **App-only.** It needs something JSON can't express, such as an arbitrary `ReactNode`
  body or a render prop. Its file carries `/** @appOnly <reason> */` and its story is
  tagged `app-only`.

Layout belongs to the catalog: `Stack` and `Group` take `gap: "xs" | "sm" | "md" | "lg"
| "xl"`, mapped to spacing tokens. Participant portal components live in the package.

**Why.** The direction is generative UI: an LLM emits a JSON spec and the app renders it,
through something like json-render or intent-ui, starting with the participant portal.
A model can only assemble from a catalog whose props it can write in JSON and choose
correctly from a small set. A non-serializable prop added now (`leftIcon={<Copy />}`)
has to change at every call site later. A serializable one only needs a schema
written next to it.

**Best practice followed.** Spec-driven renderers define a catalog of components with a
schema for each one's props (json-render's catalog and Zod schemas). Kumo also exports a
catalog and a registry alongside its components. We take the constraint now and leave
the schemas for later.

**Where we deviate.** No schemas yet. Serializability is a convention, checked in review
and by one story per catalog component whose args are parsed from a JSON string, not by
a type-level or lint rule.

**Against.** Some APIs get clunkier for people: an icon is a registry name, and a button's
`children` is a string. Composites with free-form bodies (a modal with arbitrary content)
become app-only, and the line between the two kinds is a judgement call. Without schemas
the rule is easy to erode one prop at a time. Writing schemas is the planned next step,
and the JSON-args stories make a broken component fail before then.
