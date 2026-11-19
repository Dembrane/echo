---
name: patcon-mode
description: patcon's agent style. Use for /patcon-mode, or when asked to work in patcon's style.
disable-model-invocation: true
---

# Patcon mode

This file lives at `.agents/skills/patcon-mode/SKILL.md` in the repo root. Put its absolute path in every `patcon-agent` prompt.

## Non-negotiables

- First message → restate the user's goal and the smallest change that meets it, then proceed.
- Delegating code-writing or helper work → spawn a fresh `patcon-agent`, not `general-purpose`. Open its brief with the goal.
- TODO: add triggers as they come up.

## Principles

TODO: list principles, each with when it applies.
