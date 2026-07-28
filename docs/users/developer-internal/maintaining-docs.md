---
title: Developing & maintaining the docs
description: How this documentation stays true to the code - the two-way sync between docs and codebase, the code-to-docs process, and the review gate.
audience: developer-internal
---

# Developing & maintaining the docs

Good docs are how this codebase stays maintainable: they are what hosts read, what the
in-app assistant cites in chat, and what agents use to reason about the system. A stale
page misleads all three. So docs and code are kept in sync *as a process*, not by memory.

The model is a two-way sync:

- *Code → docs* (live today): a merged code change gets propagated into every affected
  page, as a reviewable PR.
- *Docs → code* (planned): editing a doc trickles the change down to the code it
  describes, using the code references on each page - also as a reviewable PR.

Either direction, the change is *subject to review*. Nothing lands on the site without a
human confirming the docs now say what the code does. Over time this pushes both sides to
improve: docs that must match code stay honest, and code that must be documentable stays
explainable and testable.

## Where things live

| Piece | Path |
|---|---|
| The published corpus | `docs/` (repo root), deployed to docs.echo-next.dembrane.com on every main push touching `docs/**` |
| What is true | `docs/_authoring/FACTS.md` - the accuracy anchor every page must agree with |
| How to write it | `docs/_authoring/STYLE.md` - voice, language, links, structure |
| The code → docs process | `.claude/skills/code-to-docs/SKILL.md` - the operational skill an agent (or you) runs |
| Engineering notes (not the site) | `echo/docs/` - ADRs, plans, backlogs |

## The code → docs process

The full procedure is the `code-to-docs` skill; ask an agent to "run code-to-docs on
PR #N" or follow it by hand. The shape:

1. *Classify the diff.* Only user-observable changes need user docs: UI, routes,
   permissions, tiers, endpoints, behaviour. "No docs impact" is a valid conclusion -
   state it. Internal architecture changes may still touch these developer pages.
2. *Map diff → pages, three ways.* By feature (`docs/features/` owns each capability),
   by audience (every `docs/users/<type>/` retelling), and by reference (grep the docs
   for exact strings the diff touched - old labels are the highest-value hits). Union
   the three lists, then always check `FACTS.md`.
3. *Update facts first.* `FACTS.md`, then the feature page, then the audience pages,
   then trickle to pages that link to or restate what you changed.
4. *Ground every claim in code.* Read the code, not the PR description. Copy UI labels
   exactly from source. If you can't verify it, leave it out - an invented detail
   becomes a confidently wrong assistant answer.
5. *Verify and open a PR.* Links resolve, new pages are reachable from `map.md`, the
   site builds. The PR body maps each docs hunk to the code change that caused it, and
   lists pages checked but deliberately left alone.

## When to run it

- After merging any PR that changes user-visible behaviour - ideally the same day.
- On a cadence, as a catch-up: diff everything merged since the docs were last synced
  (`git log --since=<last sync> -- ':!docs'`) and run the process over the batch.
- Whenever someone reports a stale page: fix the page *and* the missed diff that made
  it stale.

## The docs → code direction (planned)

The other half: a docs edit becomes the spec, and the change trickles down to the code
the page references, plus every related item, as a reviewable PR. That needs stable
code references on each page before it can be trusted; the direction is recorded here so
the process has a home when it lands.

## Related

- [Internal developer overview](./index.md) - orientation for engineers.
- [Deployment & releases](./deployment-and-releases.md) - how a docs merge reaches the
  site (main push → Pages deploy).
- [Chat & the agent service](./chat-and-agent.md) - the assistant that cites these pages
  in chat.
