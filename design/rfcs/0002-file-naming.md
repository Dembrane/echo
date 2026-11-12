---
status: approved
---

# 0002 File naming

## Rule

- Component files are `PascalCase.tsx` and match the component they export.
- Hook files are `useCamelCase.ts` and match the hook.
- Every other module is `camelCase.ts` and matches its main export.
- A name says what the module is or does. `utils.ts`, `helpers.ts` and `misc.ts` give way to a name for the content (`classNames.ts`, `scrollToBottom.ts`).

"Matches its main export" is reviewed, not measured.

## Target

`Measure` prints nothing.

## Measure

Run from the repository root. Each output line is one violation.

```bash
git ls-files -- 'dembrane/frontend/src/*.ts' 'dembrane/frontend/src/*.tsx' \
    'dembrane/platform/packages/*/src/*.ts' 'dembrane/platform/apps/*/src/*.ts' \
  | grep -vE '/locales/|\.(test|spec|d|gen|generated)\.tsx?$|/errors/messages/(agent_access|rate_limit)\.ts$|/catalog/(agent_access|rate_limit)\.ts$' \
  | awk -F/ '{ f=$NF; sub(/\.(worker\.)?tsx?$/, "", f)
      if (f ~ /^(utils|helpers|misc)$/) { print $0 "  (generic name)"; next }
      if (f !~ /^([A-Z][A-Za-z0-9]*|[a-z][A-Za-z0-9]*)$/) print $0 "  (not PascalCase/camelCase)" }'
```

## Exceptions

- Test, declaration and generated files (`.test`, `.spec`, `.d`, `.gen`, `.generated`).
- `*.worker.ts` keeps its `.worker` suffix.
- Locale files (`en-US.ts`), which are named by locale code.
- `agent_access.ts` and `rate_limit.ts` under `lib/errors/messages` and `core/src/catalog`, which mirror error-domain identifiers.
- `index.ts` and `index.tsx` as folder entry points.

## Lock-in

Biome `style/useFilenamingConvention` with `filenameCases: ["camelCase", "PascalCase"]`, set to `error` in `dembrane/frontend/biome.json` and `dembrane/platform/biome.json`. Files that still violate sit in an `overrides` entry that turns the rule off; each run removes the entries it fixed. `utils`/`helpers`/`misc` names are guarded by the Measure command until a rule covers them.

## Rationale

- At adoption, 562 platform source files are camelCase and 59 are kebab-case; the frontend is conformant apart from two `utils.ts` files. One convention per file kind lets a reader predict a file's name from its export.
- Adapted from the Naming rule in [intent-ui's engineering-standards](https://github.com/Brayden/intent-ui/blob/main/skills/engineering-standards/SKILL.md).
