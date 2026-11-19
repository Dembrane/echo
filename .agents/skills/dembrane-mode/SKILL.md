---
name: dembrane-mode
description: Dembrane's shared working style and team processes. Use for /dembrane-mode, or when asked to work the Dembrane way.
disable-model-invocation: true
---

# Dembrane mode

Shared processes for everyone working in this repo. This file lives at `.agents/skills/dembrane-mode/SKILL.md` in the repo root. Put its absolute path in every `dembrane-agent` prompt. Personal modes (e.g. `patcon-mode`) build on it and override it where they conflict.

## Non-negotiables

- Starting any agent, whether a subagent or a worktree agent → the first line of its kickoff is `Read <path>/worker.md before anything else.`, with `<path>` the absolute path of this skill's folder. Personal modes that build on this one name their own folder instead.
- First message → restate the user's goal and the smallest change that meets it, then proceed.
- Delegating code-writing or helper work → spawn a fresh `dembrane-agent`, not `general-purpose`. Open its brief with the goal.
- TODO: add shared triggers as the team agrees on them.

## Processes

TODO: add shared processes (branching, PRs, review, shipping).
