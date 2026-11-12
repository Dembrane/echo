---
status: proposed
---

# 0002 Naming and exports

Two rules, adapted from [intent-ui's engineering-standards](https://github.com/Brayden/intent-ui/blob/main/skills/engineering-standards/SKILL.md). A violation of either is one line of Measure.

## Rules

**File naming**

- Component files are `PascalCase.tsx` and match the component they export.
- Hook files are `useCamelCase.ts` and match the hook.
- Every other module is `camelCase.ts` and matches its main export.
- A name says what the module is or does. `utils.ts`, `helpers.ts` and `misc.ts` give way to a name for the content (`classNames.ts`, `scrollToBottom.ts`).
- "Matches its main export" is reviewed, not measured.

**Named exports**

- Source modules use named exports. A default export appears only where a tool requires one: config files (`*.config.ts`, `packages/config/environments/*`), which sit outside the measured paths.
- A `React.lazy` call site adapts a named export with `.then((m) => ({ default: m.Name }))`.
- Not adopted yet: exposing each feature folder through `index.ts`.

## Target

`Measure` prints nothing.

## Measure

Run from the repository root.

```bash
{
  git ls-files -- 'dembrane/frontend/src/*.ts' 'dembrane/frontend/src/*.tsx' \
      'dembrane/platform/packages/*/src/*.ts' 'dembrane/platform/apps/*/src/*.ts' \
    | grep -vE '/locales/|\.(test|spec|d|gen|generated)\.tsx?$|/errors/messages/(agent_access|rate_limit)\.ts$|/catalog/(agent_access|rate_limit)\.ts$' \
    | awk -F/ '{ f=$NF; sub(/\.(worker\.)?tsx?$/, "", f)
        if (f ~ /^(utils|helpers|misc)$/) { print $0 "  (generic name)"; next }
        if (f !~ /^([A-Z][A-Za-z0-9]*|[a-z][A-Za-z0-9]*)$/) print $0 "  (not PascalCase/camelCase)" }'
  git grep -lE '^export default' -- 'dembrane/frontend/src' 'dembrane/platform/packages/*/src' 'dembrane/platform/apps/*/src' \
    | sed 's/$/  (default export)/'
}
```

## Exceptions

- Test, declaration and generated files (`.test`, `.spec`, `.d`, `.gen`, `.generated`) are exempt from naming.
- `*.worker.ts` keeps its `.worker` suffix.
- Locale files (`en-US.ts`) are named by locale code.
- `agent_access.ts` and `rate_limit.ts` under `lib/errors/messages` and `core/src/catalog` mirror error-domain identifiers.
- `index.ts` and `index.tsx` are folder entry points.
- No exceptions to named exports inside the measured paths.

## Lock-in

Biome in `dembrane/frontend/biome.json` and `dembrane/platform/biome.json`, both rules at `error`:

- `style/useFilenamingConvention` with `filenameCases: ["camelCase", "PascalCase"]`.
- `style/noDefaultExport`.

Files that still violate sit in an `overrides` entry that turns the rule off; each run removes the entries it fixed. `utils`/`helpers`/`misc` names are guarded by Measure until a rule covers them.

## Rationale

- At adoption, 562 platform source files are camelCase and 59 are kebab-case; the frontend is conformant apart from two `utils.ts` files. One convention per file kind lets a reader predict a file's name from its export.
- 15 frontend files have a default export and no platform source file does. Named exports keep one import name per symbol and make rename and find-usages reliable.
- One RFC holds both rules because they share a Measure, a state file and a run cadence.
