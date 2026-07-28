# Brief: Wave 6b - methodology select + edit (QoL, owner-requested)

v1 shipped methodology as schema + endpoints + the seeded "dembrane" methodology; the
owner now wants hosts to SELECT a methodology for a project and EDIT methodologies -
a lightweight surface, not the full explorer (that stays later; see plan D11). Read:
`echo/docs/plans/smart-loop.md` D11, wave5-server-REPORT.md (contract), the story's
"evening before" beat, `echo/frontend/AGENTS.md`.

Existing contract: `GET /v2/bff/methodologies?workspace_id=` -> [{id, name,
description, framing, is_seeded, latest_version:{id, note, created_at}|null}];
project PATCH (bff) accepts `methodology_version_id`.

Deliverables:

1. SERVER additions (echo/server, mirror existing bff styles + tests):
   - `POST /v2/bff/methodologies` (workspace member) {workspace_id, name, description,
     framing, content?} -> creates methodology (owner = caller, visibility 'workspace',
     is_seeded false) + first version. Returns the list-item shape.
   - `POST /v2/bff/methodologies/{id}/versions` (owner, or workspace admin for
     workspace-visible ones; seeded methodologies are NOT editable -> 403
     {"detail": "The dembrane methodology is read-only"}) {name?, description?,
     framing?, content?, note?} -> metadata edits update the methodology row; content
     changes append a methodology_version. Returns updated list-item shape.
   - `GET /v2/bff/methodologies/{id}` -> full detail incl. version history
     [{id, note, created_by, created_at, content}].
2. FRONTEND (echo/frontend):
   - Project settings: a "Methodology" section (near the goal section): shows the
     project's current methodology+version (or "dembrane - the default"), a Select
     control (Mantine Select fed by the list endpoint; choosing one PATCHes
     methodology_version_id with the chosen methodology's latest version; "dembrane
     (default)" option maps to the seeded one), and the chosen methodology's framing
     text shown as plain description under the selector.
   - A workspace-level "Methodologies" card on the workspace settings general tab
     (below assistant memory): list (name, framing, versions count, "dembrane" marked
     as built-in/read-only), "New methodology" (InputModal-style small form or an
     inline form: name, description, framing), and per-row Edit opening a modal
     (name/description/framing + content textarea (json or plain text per the detail
     shape) + note) that saves via the versions endpoint. Seeded row shows no Edit.
   - Copy: brand rules binding (lowercase dembrane, never "AI", sentence case, honest,
     no jargon like "versioning" - say "history"). All strings via lingui.
   - Hooks: methodology hub per house conventions, fixture fallback in dev.
3. QA: server unit tests (create/edit/gate incl. the seeded-read-only 403); frontend
   Playwright (settings select renders + patches; workspace list + create + edit; the
   seeded row not editable); gates: whole-tree ruff, server tests (known 4 pre-existing
   failures), tsc, lint, lingui extract+compile.

Constraints: no git write commands; do not touch src/routes/project/library/,
src/components/canvas/, src/components/chat/ (a parallel agent may fix issues there).
Report -> echo/docs/plans/smart-loop-briefs/wave6b-REPORT.md.
