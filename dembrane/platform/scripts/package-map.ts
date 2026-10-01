#!/usr/bin/env bun
/**
 * The package map: which layer each workspace package sits in, who imports whom, and the
 * rule that a dependency points down only (apps, then namespaces, then capabilities).
 *   bun run packages check   the layer rule holds and PACKAGES.md is current
 *   bun run packages write   rewrites that section from package.json files and imports
 * Each package declares its layer and one-line description in its package.json:
 *   "description": "...", "dembrane": { "layer": "namespace", "allow": { "<ns>": "why" } }
 * Apps take their layer from the folder. `allow` names the other namespaces a namespace
 * may import, each with its reason; everything else is read from the source.
 */
import { Glob } from "bun";

export type Layer = "app" | "namespace" | "capability";
export const LAYERS: readonly Layer[] = ["app", "namespace", "capability"];

export interface Pkg {
  readonly name: string;
  readonly dir: string;
  readonly layer: Layer | undefined;
  readonly description: string;
  readonly declared: ReadonlySet<string>;
  readonly allow: Readonly<Record<string, string>>;
  /** Workspace packages imported by source files, excluding itself. */
  readonly imports: ReadonlySet<string>;
  /** Workspace packages imported only by tests. */
  readonly testImports: ReadonlySet<string>;
}

const SCOPE = "@dembrane/";
const IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']@dembrane\/([a-z0-9-]+)(?:\/[^"']*)?["']/g;

const short = (name: string) => name.slice(SCOPE.length);
const isTest = (f: string) =>
  f.includes("/test/") || f.startsWith("test/") || /\.test\.tsx?$/.test(f);

async function readPkg(root: string, dir: string): Promise<Pkg> {
  const json = await Bun.file(`${root}/${dir}/package.json`).json();
  const name = short(json.name as string);
  const meta = (json.dembrane ?? {}) as { layer?: Layer; allow?: Record<string, string> };
  const deps = { ...json.dependencies, ...json.devDependencies } as Record<string, string>;
  const imports = new Set<string>();
  const testImports = new Set<string>();
  for await (const f of new Glob("**/*.{ts,tsx}").scan(`${root}/${dir}`)) {
    if (f.includes("node_modules/") || f.startsWith("dist/")) continue;
    const code = await Bun.file(`${root}/${dir}/${f}`).text();
    for (const m of code.matchAll(IMPORT)) {
      const to = m[1] as string;
      if (to !== name) (isTest(f) ? testImports : imports).add(to);
    }
  }
  for (const i of imports) testImports.delete(i);
  return {
    name,
    dir,
    layer: dir.startsWith("apps/") ? "app" : meta.layer,
    description: (json.description as string | undefined) ?? "",
    declared: new Set(
      Object.keys(deps)
        .filter((d) => d.startsWith(SCOPE))
        .map(short),
    ),
    allow: meta.allow ?? {},
    imports,
    testImports,
  };
}

export async function readWorkspace(root: string): Promise<Pkg[]> {
  const dirs: string[] = [];
  for await (const f of new Glob("{apps,packages}/*/package.json").scan(root)) {
    dirs.push(f.replace(/\/package\.json$/, ""));
  }
  return Promise.all(dirs.sort().map((d) => readPkg(root, d)));
}

/** Everything that breaks the map: undeclared layers, upward imports, stale allowances. */
export function problems(pkgs: readonly Pkg[]): string[] {
  const byName = new Map(pkgs.map((p) => [p.name, p]));
  const out: string[] = [];
  for (const p of pkgs) {
    if (!p.layer || !LAYERS.includes(p.layer)) {
      out.push(`${p.name}: package.json needs "dembrane": { "layer": "namespace" | "capability" }`);
      continue;
    }
    if (!p.description) out.push(`${p.name}: package.json needs a one-line "description"`);
    for (const [to, test] of [
      ...[...p.imports].map((t) => [t, false] as const),
      ...[...p.testImports].map((t) => [t, true] as const),
    ]) {
      const dep = byName.get(to);
      const where = test ? " (in a test)" : "";
      if (!dep) {
        out.push(`${p.name} imports @dembrane/${to}${where}, which is not a workspace package`);
        continue;
      }
      if (!p.declared.has(to)) {
        out.push(`${p.name} imports @dembrane/${to}${where} without declaring it in package.json`);
      }
      if (dep.layer === "app")
        out.push(`${p.name} imports the app ${to}${where}; apps are not libraries`);
      else if (p.layer === "capability" && dep.layer === "namespace") {
        out.push(
          `${p.name} is a capability and imports the namespace ${to}${where}; move what it needs down`,
        );
      } else if (p.layer === "namespace" && dep.layer === "namespace" && !p.allow[to]) {
        out.push(
          `${p.name} imports the namespace ${to}${where}; move the shared piece into a capability, or add "${to}" with a reason to ${p.name}'s dembrane.allow`,
        );
      }
    }
    for (const to of Object.keys(p.allow)) {
      if (p.layer !== "namespace") out.push(`${p.name}: only namespaces take an allow list`);
      else if (!p.imports.has(to) && !p.testImports.has(to)) {
        out.push(`${p.name} allows ${to} but no longer imports it; remove the entry`);
      }
    }
  }
  return out;
}

interface Stats {
  readonly fanIn: number;
  readonly reach: number;
  readonly users: readonly string[];
}

function stats(pkgs: readonly Pkg[]): Map<string, Stats> {
  const users = new Map<string, string[]>(pkgs.map((p) => [p.name, []]));
  for (const p of pkgs) for (const to of p.imports) users.get(to)?.push(p.name);
  // Reach: every package that depends on it directly or through others.
  const reach = (name: string, seen = new Set<string>()): Set<string> => {
    for (const u of users.get(name) ?? []) if (!seen.has(u)) reach(u, seen.add(u));
    return seen;
  };
  return new Map(
    pkgs.map((p) => {
      const u = users.get(p.name) ?? [];
      return [p.name, { fanIn: u.length, reach: reach(p.name).size, users: u }];
    }),
  );
}

const START_TAG = "<!-- package-map:start";
const START = `${START_TAG} (generated by \`bun run packages write\`; do not edit) -->`;
const END = "<!-- package-map:end -->";

export function render(pkgs: readonly Pkg[]): string {
  const byName = new Map(pkgs.map((p) => [p.name, p]));
  const st = stats(pkgs);
  const s = (n: string) => st.get(n) as Stats;
  const layerOf = (n: string) => byName.get(n)?.layer;
  const rank = (a: string, b: string) =>
    s(b).fanIn - s(a).fanIn || s(b).reach - s(a).reach || a.localeCompare(b);
  const namespaces = pkgs.filter((p) => p.layer === "namespace");
  // Capabilities most namespaces use say nothing about any one of them; they are named once.
  const base = pkgs
    .filter((p) => p.layer === "capability")
    .map((p) => p.name)
    .filter((c) => namespaces.filter((n) => n.imports.has(c)).length * 2 > namespaces.length)
    .sort(rank);
  const list = (names: string[], max: number) =>
    names.length > max
      ? `${names.slice(0, max).join(", ")} and ${names.length - max} more`
      : names.join(", ");

  const plural: Record<Layer, string> = {
    app: "apps",
    namespace: "namespaces",
    capability: "capabilities",
  };
  const level = (n: string) => LAYERS.indexOf(layerOf(n) as Layer);
  const lines: string[] = [START, ""];
  const counts = LAYERS.map((l) => `${pkgs.filter((p) => p.layer === l).length} ${plural[l]}`);
  lines.push(
    `${counts.join(", ")}. "in" is how many packages import it, "out" how many it imports.`,
  );
  lines.push(`Most namespaces use ${base.join(", ")}; the lines below leave those out.`, "");
  for (const layer of LAYERS) {
    const title = plural[layer];
    lines.push(`**${title.charAt(0).toUpperCase()}${title.slice(1)}**`, "");
    const inLayer = pkgs.filter((p) => p.layer === layer).map((p) => p.name);
    const out = (n: string) => (byName.get(n) as Pkg).imports.size;
    const order =
      layer === "app" ? (a: string, b: string) => out(b) - out(a) || a.localeCompare(b) : rank;
    for (const name of inLayer.sort(order)) {
      const p = byName.get(name) as Pkg;
      const deps = [...p.imports];
      const head = `- **${name}** (in ${s(name).fanIn}, out ${deps.length}): ${p.description}`;
      if (layer === "app") {
        const ns = deps.filter((d) => layerOf(d) === "namespace").sort(rank);
        const caps = deps.length - ns.length;
        const what =
          ns.length > 3
            ? `${ns.length} namespaces and ${caps} capabilities`
            : ns.length
              ? `${ns.join(", ")} and ${caps} capabilities`
              : list(deps.sort(rank), 5);
        lines.push(`${head} Uses ${what}.`);
        continue;
      }
      // Uses: its own layer first, then the rarer capabilities, which say most about it.
      const uses = deps
        .filter((d) => layer !== "namespace" || !base.includes(d))
        .sort((a, b) => level(a) - level(b) || s(a).fanIn - s(b).fanIn || a.localeCompare(b));
      const users = [...s(name).users].sort((a, b) => level(b) - level(a) || rank(a, b));
      const usedBy = `Used by ${users.length ? list(users, 4) : "nothing yet"}.`;
      const usesText = uses.length
        ? `Uses ${list(uses, 5)}.`
        : deps.length
          ? "Uses only the common ones."
          : "Uses nothing.";
      lines.push(`${head} ${usedBy} ${usesText}`);
    }
    lines.push("");
  }
  lines.push("**Allowed imports between namespaces**", "");
  const allowed = namespaces.flatMap((p) =>
    Object.entries(p.allow).map(([to, why]) => `- ${p.name} uses ${to}: ${why}`),
  );
  lines.push(...(allowed.length ? allowed.sort() : ["- none"]), "", END);
  return lines.join("\n");
}

export function splice(readme: string, section: string): string {
  const a = readme.indexOf(START_TAG);
  const b = readme.indexOf(END);
  if (a < 0 || b < 0) throw new Error("PACKAGES.md has no package-map markers");
  return readme.slice(0, a) + section + readme.slice(b + END.length);
}

if (import.meta.main) {
  const root = new URL("..", import.meta.url).pathname;
  const cmd = process.argv[2] ?? "check";
  const pkgs = await readWorkspace(root);
  const readmePath = `${root}/PACKAGES.md`;
  const readme = await Bun.file(readmePath).text();
  const next = splice(readme, render(pkgs));
  const found = problems(pkgs);
  if (cmd === "write") {
    await Bun.write(readmePath, next);
  } else if (cmd !== "check") {
    throw new Error("usage: package-map.ts check | write");
  } else if (next !== readme) {
    found.push("PACKAGES.md is stale; run `bun run packages write`");
  }
  for (const f of found) process.stderr.write(`${f}\n`);
  process.exit(found.length ? 1 : 0);
}
