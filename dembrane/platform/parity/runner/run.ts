#!/usr/bin/env bun
/**
 * Parity runner: each scenario against the Python API and the Bun API, each from a fresh
 * copy of the same template; compares status, body and changed rows.
 *   bun parity/runner/run.ts [filter]       filter matches scenario file or name
 * Needs: parity stack up, parity/prepare-platform-template.sh run, old API on :8100,
 * new API on :8200 (both on database "dembrane"), parity/.env.parity loaded.
 */
import { Glob } from "bun";
import { call, NEW, newToken, OLD, oldToken, sideOf } from "./clients";
import { diff, reset, runSetup, snapshot } from "./db";
import { normalize, withoutAdditiveErrorFields } from "./normalize";
import type { Scenario, Vars } from "./scenario";

const filter = process.argv[2] ?? "";
const here = new URL("..", import.meta.url).pathname;
const out = (s: string) => process.stdout.write(`${s}\n`);

async function collectSeedIds(): Promise<Set<string>> {
  await reset();
  const ids = new Set<string>();
  const re = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  for (const rows of (await snapshot()).values())
    for (const row of rows.values())
      for (const m of JSON.stringify(row).match(re) ?? []) ids.add(m.toLowerCase());
  return ids;
}

async function side(
  base: string,
  token: (as: Scenario["as"]) => Promise<string | null>,
  s: Scenario,
) {
  await reset();
  await Bun.sleep(50);
  // Sign in before the setup runs, so a setup that turns on two-factor or suspends the
  // user still leaves the scenario a session to act with.
  const t = await token(s.as);
  if (s.setup) await runSetup(s.setup);
  let vars: Vars = {};
  const before = await snapshot();
  if (s.prepare) vars = await s.prepare(sideOf(base, token), { old: sideOf(OLD, oldToken) });
  const res = await call(base, t, s, vars);
  const changes = diff(before, await snapshot());
  const prepared = Object.fromEntries(Object.entries(vars).filter(([k]) => !k.startsWith("_")));
  return { ...res, changes, ...(s.prepare && { prepared }) };
}

async function dump(name: string, a: string, b: string) {
  const base = `${here}.parity-out/${name.replace(/[^a-z0-9]+/gi, "_")}`;
  await Bun.write(`${base}.old.json`, a);
  await Bun.write(`${base}.new.json`, b);
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const seedIds = await collectSeedIds();
const files = [...new Glob("scenarios/**/*.ts").scanSync(here)].sort();
let pass = 0;
let fail = 0;
const failures: string[] = [];
for (const file of files) {
  const list: Scenario[] = (await import(`${here}${file}`)).default;
  for (const s of list) {
    if (filter && !file.includes(filter) && !s.name.includes(filter)) continue;
    if (s.removed) {
      const n = await side(NEW, newToken, s);
      if (n.status === 404) {
        pass++;
        out(`  ok    ${s.name}  (removed: ${s.removed})`);
      } else {
        fail++;
        failures.push(s.name);
        out(`  FAIL  ${s.name}\n        marked as removed, but the new API answered ${n.status}`);
      }
      continue;
    }
    const ignore = new Set(s.ignoreFields ?? []);
    const ids = new Set(seedIds);
    const setupText = typeof s.setup === "string" ? s.setup : (s.setup ?? []).join("\n");
    for (const m of setupText.match(UUID_RE) ?? []) ids.add(m.toLowerCase());
    const [o, n] = [await side(OLD, oldToken, s), await side(NEW, newToken, s)];
    const a = JSON.stringify(
      normalize(
        {
          status: o.status,
          body: o.body,
          headers: o.headers,
          prepared: o.prepared,
          changes: o.changes,
        },
        ids,
        ignore,
      ),
      null,
      1,
    );
    const b = JSON.stringify(
      normalize(
        {
          status: n.status,
          body: withoutAdditiveErrorFields(n.status, n.body, o.body),
          headers: n.headers,
          prepared: n.prepared,
          changes: n.changes,
        },
        ids,
        ignore,
      ),
      null,
      1,
    );
    const same = a === b;
    const ok = s.differs ? !same : same;
    if (ok) {
      pass++;
      out(`  ok    ${s.name}${s.differs ? `  (differs on purpose: ${s.differs})` : ""}`);
      // A deliberate difference is only as good as its review: keep both sides to read.
      if (s.differs) await dump(s.name, a, b);
    } else {
      fail++;
      failures.push(s.name);
      out(`  FAIL  ${s.name}`);
      if (!same) {
        await dump(s.name, a, b);
        out(`        old ${o.status}, new ${n.status}; full captures in parity/.parity-out/`);
      } else out("        marked as differing, but both sides now match: remove the note");
    }
  }
}
out(`\n${pass} passed, ${fail} failed (old ${OLD}, new ${NEW})`);
if (fail) process.exit(1);
