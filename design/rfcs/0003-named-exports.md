---
status: approved
---

# 0003 Named exports

## Rule

Source modules use named exports. A default export appears only where a tool requires one: config files (`*.config.ts`, `packages/config/environments/*`), which sit outside the measured paths.

A `React.lazy` call site adapts a named export with `.then((m) => ({ default: m.Name }))`.

Not adopted yet: exposing each feature folder through `index.ts`.

## Target

`Measure` prints nothing.

## Measure

Run from the repository root. Each output line is one file with a default export.

```bash
git grep -lE '^export default' -- 'dembrane/frontend/src' 'dembrane/platform/packages/*/src' 'dembrane/platform/apps/*/src'
```

## Exceptions

None inside the measured paths.

## Lock-in

Biome `style/noDefaultExport` set to `error` in `dembrane/frontend/biome.json` and `dembrane/platform/biome.json`. Files that still export a default sit in an `overrides` entry that turns the rule off; each run removes the entries it fixed.

## Rationale

- At adoption, 15 frontend files have a default export and no platform source file does. Named exports keep one import name per symbol across the codebase and make rename and find-usages reliable.
- Adapted from the Exports rule in [intent-ui's engineering-standards](https://github.com/Brayden/intent-ui/blob/main/skills/engineering-standards/SKILL.md).
