# Project report

A host opens a project's Report page to read the report generated from its conversations, share it, and correct it in "Edit mode", where a formatting toolbar sticks under the report's own sticky toolbar.

## Sub-features

- `report-generate` queues a report with "Generate now". Fails locally: the worker needs an LLM, which `.env.local` leaves unset, and the row ends with `status = 'error'`, `error_code = 'GENERATION_FAILED'`.
- `report-view` reads a finished report. Proven on the Millbrook sample.
- `report-edit` turns on "Edit mode" and edits the report in the formatting editor. Proven on the Millbrook sample.

## How to get to it (user POV)

- A project's sidebar: "Report".
- `/w/<workspace-id>/projects/<project-id>/report`.

## Driving it with agent-browser

Preconditions:

- Signed in with onboarding finished: `scripts/seed-user.sh --org "Verify Org"` and the login batch in [auth.md](./auth.md). `seed-user.sh` prints the account's `workspace_id`.
- A finished report. Try `report-generate` first on the "Best practices (sample)" project and record its failure. Then run `scripts/seed-report.sh <workspace_id>`. It prints the sample's `workspace_id` and `project_id`, and seeds the product's Millbrook sample for the account: the organisation "Acme Civic (sample)" with a published report. This is the one place a recipe writes to the database to skip a step, like minting the verification link, because no report can be generated locally. Say so in `proof.md`.

`report-view` and `report-edit`:

```sh
S=.agents/skills/verify-dembrane/scripts
$S/evidence.sh query "sample report" "select project_id, id, status from project_report where status = 'published'"
agent-browser --session "$SESSION" open "$DASHBOARD_URL/w/<sample workspace_id>/projects/<project_id>/report"
agent-browser --session "$SESSION" wait --fn "!document.querySelector('[class*=stageHost]')"
$S/evidence.sh step report-view
agent-browser --session "$SESSION" find label "Edit mode" check
$S/evidence.sh step report-edit
```

## Gotchas

- The page scrolls inside `SECTION.overflow-y-auto`, not the window. Scroll that element, and measure sticky elements relative to it.
- The report toolbar wraps its second row below about 540px wide, and at wider widths with longer labels such as Dutch. Check layout at both a wide and a phone width.
- Seeding uses fixed ids, so it gives one account per run a sample report.
