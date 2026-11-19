---
name: dembrane-mode
description: Dembrane's shared working style and team processes, layered on pstack's poteto-mode. Use for /dembrane-mode, or when asked to work the Dembrane way.
disable-model-invocation: true
---

# Dembrane mode

The team layer for everyone working in this repo. This file lives at `.agents/skills/dembrane-mode/SKILL.md` in the repo root. Personal modes (e.g. `patcon-mode`) build on it and override it where they conflict.

## Base

Run `.agents/skills/dembrane-mode/scripts/pstack-root.sh`. It prints the folder of the pstack plugin that `.claude/settings.json` installs and pins ([browse that version](https://github.com/cursor/plugins/tree/35a90942a7f02e1ebbc2443643179815f2147954/harness/pstack/claude-code/skills/poteto-mode)). Read `<folder>/skills/poteto-mode/SKILL.md` in full and follow it, including everything it tells you to read. Where it conflicts with this file, this file wins. If the script fails, stop and pass its message to the user.

## Overrides

- poteto-mode's kickoff rule names this skill's folder, not poteto-mode's: the first line of every agent kickoff is `Read <path>/worker.md before anything else.`, with `<path>` the absolute path of this folder.
- Spawn `dembrane-agent` wherever poteto-mode says `poteto-agent`, and put this file's absolute path in its prompt.
- `cursor-team-kit` isn't installed here. Skip `/deslop`. For `control-ui`, use the `verify-dembrane` skill.

## Processes

- Dashboard or portal change → prove it on a running copy with the `verify-dembrane` skill before calling it done. Pure logic, or a refactor with no visible change → unit tests are enough.
- A flow verified by hand twice → turn its `verify-dembrane` recipe into a spec under `dembrane/frontend/e2e/`.
- TODO: add shared processes (branching, PRs, review, shipping).
