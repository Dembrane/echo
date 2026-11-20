---
name: patcon-mode
description: patcon's agent style, layered on dembrane-mode. Use for /patcon-mode, or when asked to work in patcon's style.
disable-model-invocation: true
---

# Patcon mode

This file lives at `.agents/skills/patcon-mode/SKILL.md` in the repo root.

## Base

Before anything else, read `.agents/skills/dembrane-mode/SKILL.md` in full and follow it, including its base. Where it conflicts with this file, this file wins.

## Overrides

- Kickoffs name this skill's folder: the first line of every agent kickoff is `Read <path>/worker.md before anything else.`, with `<path>` the absolute path of this folder.
- Spawn `patcon-agent` wherever the base says `dembrane-agent` or `poteto-agent`, and put this file's absolute path in its prompt.
- When an issue or the user prescribes a fix, treat it as one hypothesis. Before implementing, list two or three options with their size and what changes for users, and say why the chosen one wins.
- A PR that changes something a user can see → put screenshots from the `verify-dembrane` evidence in its description, as a before/after table at the same widths and states. Pick the pair that shows the change most plainly. Host them where the PR can display them, not as files in the PR's diff.
- TODO: add overrides as they come up.
