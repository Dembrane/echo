---
name: patcon-mode
description: patcon's agent style. Use for /patcon-mode, or when asked to work in patcon's style.
disable-model-invocation: true
---

# Patcon mode

This file lives at `.agents/skills/patcon-mode/SKILL.md` in the repo root. Put its absolute path in every `patcon-agent` prompt.

## Base

Before anything else, read `.agents/skills/dembrane-mode/SKILL.md` in full and follow it. Where it conflicts with this file, this file wins.

## Non-negotiables

- Delegating code-writing or helper work → spawn a fresh `patcon-agent`, not `general-purpose`. Open its brief with the goal.
- TODO: add triggers as they come up.

## Principles

TODO: list principles, each with when it applies.
