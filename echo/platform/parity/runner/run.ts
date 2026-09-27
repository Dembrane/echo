#!/usr/bin/env bun
/**
 * Parity runner: each scenario against the Python API and the Bun API, each from a fresh
 * copy of the same template; compares status, body and changed rows.
 *   bun parity/runner/run.ts [filter]       filter matches scenario file or name
 * Needs: parity stack up, parity/prepare-platform-template.sh run, old API on :8100,
 * new API on :8200 (both on database "dembrane"), parity/.env.parity loaded.
 */
import { Glob } from "bun";
import { call, NEW, newToken, OLD, oldToken } from "./clients";
import { diff, reset, snapshot } from "./db";
import { normalize } from "./normalize";
import type { Scenario } from "./scenario";

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
  const t = await token(s.as);
  const before = await snapshot();
  const res = await call(base, t, s);
  const changes = diff(before, await snapshot());
  return { ...res, changes };
}

const seedIds = await collectSeedIds();
const files = [...new Glob("scenarios/**/*.ts").scanSync(here)].sort();
let pass = 0;
let fail = 0;
const failures: string[] = [];
for (const file of files) {
  const list: Scenario[] = (await import(`${here}${file}`)).default;
  for (const s of list) {
    if (filter && !file.includes(filter) && !s.name.includes(filter)) continue;
    const ignore = new Set(s.ignoreFields ?? []);
    const [o, n] = [await side(OLD, oldToken, s), await side(NEW, newToken, s)];
    const a = JSON.stringify(
      normalize({ status: o.status, body: o.body, changes: o.changes }, seedIds, ignore),
      null,
      1,
    );
    const b = JSON.stringify(
      normalize({ status: n.status, body: n.body, changes: n.changes }, seedIds, ignore),
      null,
      1,
    );
    const same = a === b;
    const ok = s.differs ? !same : same;
    if (ok) {
      pass++;
      out(`  ok    ${s.name}${s.differs ? `  (differs on purpose: ${s.differs})` : ""}`);
    } else {
      fail++;
      failures.push(s.name);
      out(`  FAIL  ${s.name}`);
      if (!same) {
        await Bun.write(`${here}.parity-out/${s.name.replace(/[^a-z0-9]+/gi, "_")}.old.json`, a);
        await Bun.write(`${here}.parity-out/${s.name.replace(/[^a-z0-9]+/gi, "_")}.new.json`, b);
        out(`        old ${o.status}, new ${n.status}; full captures in parity/.parity-out/`);
      } else out("        marked as differing, but both sides now match: remove the note");
    }
  }
}
out(`\n${pass} passed, ${fail} failed (old ${OLD}, new ${NEW})`);
if (fail) process.exit(1);
