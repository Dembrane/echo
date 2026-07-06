---
name: code-to-docs
description: >-
  Propagate a code change into the documentation corpus (docs/). Use after
  merging or before shipping any change that alters user-visible behaviour
  (UI, routes, permissions, tiers, endpoints, copy), or when someone says
  "the docs are out of date", "sync the docs", or "update docs for this PR".
  Takes PR numbers or a commit range; maps the diff to affected docs pages,
  updates them grounded in the code, and opens a review PR. Never pushes
  docs straight to main.
---

# code-to-docs: propagate a code diff into the docs

This is the code → docs half of the two-way docs/code sync. (The docs → code
half - editing a doc and trickling the change into code - is planned, not
built.) The docs corpus is `docs/` at the repo root, published to
docs.echo-next.dembrane.com on every main push touching `docs/**`. The agent
service also cites these pages in chat, so stale docs mislead both people
and the assistant.

Read `docs/_authoring/FACTS.md` (what is true) and `docs/_authoring/STYLE.md`
(how to write it) before touching any page. They override anything here.

## Input

One of, in order of preference:

1. PR numbers: `gh pr view <n>` + `gh pr diff <n>` for each.
2. A commit range: `git log --oneline <range>` + `git diff <range>`.
3. Nothing given: diff the current branch against main and confirm the scope
   with the user before writing.

When docs have drifted for a while, find the catch-up range with
`git log --oneline --since=<last docs sync> -- ':!docs'` and treat every
user-visible PR in it as input.

## Procedure

### 1. Classify the diff

For each change, decide: does it alter something a reader can observe?

- UI surfaces, labels, flows, empty states, buttons
- Routes and navigation
- Permissions, roles, tiers, limits, prices
- Endpoints or fields external developers use
- Behaviour: what gets stored, who can see it, when things fire

Internal-only changes (refactors, tests, CI, performance with no visible
effect) need no docs. Say so explicitly in your output - "no docs impact"
is a valid, reviewable conclusion. Internal ARCHITECTURE changes may still
affect `docs/users/developer-internal/*`; check that section before
concluding no impact.

### 2. Map the diff to pages

Build the candidate list from three directions; union them:

- **By feature**: which `docs/features/<feature>.md` page owns each changed
  behaviour? `docs/map.md` is the index of everything.
- **By audience**: every `docs/users/<type>/` page that retells an affected
  feature. `grep -rli '<feature term>' docs/users` - the same capability is
  deliberately documented once per audience.
- **By reference**: grep the docs for exact strings from the diff - old UI
  labels, route paths, endpoint names, tier names. Every hit is a candidate.
  Old labels that the diff renamed or removed are the highest-value hits.

Then add the structural pages: `docs/_authoring/FACTS.md` (always check),
`docs/map.md` and the section `index.md` (only when a page is added or
retitled), and the `.nl-NL.md` twin of every page you touch, if one exists.

### 3. Update, facts first

Order matters:

1. **FACTS.md first.** It is the corpus's source of truth; every page must
   agree with it. Update the affected sections (roles, tiers, routes,
   feature inventory) before any prose page.
2. **The feature page** (`docs/features/`) - the canonical reference.
3. **The audience pages** (`docs/users/`) - retell from that reader's
   vantage; they link back to the feature page and must not contradict it.
4. **Trickle to related pages.** After editing a page, grep for pages that
   link to it or restate the same behaviour, and reconcile them. A change
   rarely lives on one page.

### 4. Ground every claim in code

- Never document from a PR title or description alone - read the code the
  diff touches. PR descriptions say what was intended; code says what
  shipped.
- UI labels must be copied exactly from source (`<Trans>` strings, `t`
  macros, button children). Never guess a label.
- Permissions and gating: read the actual policy checks (`require`,
  `has_policy`, tier gates), not the PR summary.
- If you cannot verify a behaviour in code, leave it out. STYLE.md's
  accuracy rule applies: write around what you don't know; never invent.
- Production vs preview: this corpus documents echo-next. Features that are
  main-only (not in a production release yet) follow the existing
  convention: mark them via [dembrane next](../../docs/features/dembrane-next.md)
  the way current pages do.

### 5. Verify

- Every relative link on touched pages resolves to a real file.
- New pages are reachable: linked from their section `index.md` AND
  `docs/map.md` (folder2website only publishes pages reachable from
  README.md by links).
- Build if the toolchain is available:
  `bunx github:spashii/folder2website#main docs --out /tmp/docs-site`
  (mirrors `.github/workflows/dev-deploy-docs.yml`). A broken build blocks
  the PR.

### 6. Open a PR - the review gate

Docs changes ship as a PR, never a direct push. One PR per code diff (or
per catch-up batch). The PR body must list, per finding:

- the code change (PR number or commit) that caused it
- the pages updated, and the pages checked but deliberately left alone
- anything you could not verify and therefore omitted

The review is the point: a human confirms the docs now say what the code
does. Merging the PR publishes the site.

## Judgement calls

- **Scope discipline**: update what the diff changed, resist rewriting whole
  pages. Reviewers must be able to map each docs hunk to a code change.
- **When code and docs disagree about intent** (the code looks wrong, the
  doc describes the desired behaviour): do not silently document the bug.
  Surface the conflict to the user - that disagreement is exactly what the
  two-way sync exists to catch.
- **Honesty over coverage**: an accurate page missing a feature beats a
  complete page with an invented detail. The docs feed the in-app assistant;
  invented details become confidently wrong answers to hosts.
