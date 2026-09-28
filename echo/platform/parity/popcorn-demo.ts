#!/usr/bin/env bun
/**
 * Synthetic demo parity: seeds echo/demos/example the old way (main's seed_demo.py through
 * Directus) and the new way (the same inputs posted to the staff route), each from a fresh
 * copy of the same template, then compares the rows written, the links printed, and what
 * each public link serves (page and bundle) after the runner's normalisers.
 *   flock /tmp/echo-parity.lock bun parity/popcorn-demo.ts      (with parity/.env.parity loaded)
 * Needs the old API on :8100, this worktree's API on PARITY_NEW_URL, and echo main checked
 * out at OLD_ECHO_DIR (parity/old-echo.sh).
 */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { users, workspaces } from "./fixtures";
import { NEW, newToken, OLD } from "./runner/clients";
import { diff, reset, snapshot } from "./runner/db";
import { normalize } from "./runner/normalize";

const here = new URL(".", import.meta.url).pathname;
const oldEcho = join(
  process.env.OLD_ECHO_DIR ?? join(process.env.HOME ?? "", "orca/workspaces/echo-parity-main"),
  "echo",
);
const server = join(oldEcho, "server");
const demos = join(oldEcho, "demos");
const out = (s: string) => process.stdout.write(`${s}\n`);

/** The example's seed inputs, made from its fixture by the local helper's own prepare(). */
function exampleFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "popcorn-demo-"));
  const program = `
import json, sys
from pathlib import Path
sys.path[:0] = [".", "scripts"]
from popcorn_demo import prepare
dest = Path(sys.argv[1])
fixture = json.loads(Path("../demos/example/fixture.json").read_text())
lang = fixture["language"]
state, settings = prepare(fixture, "https://portal.example.test/nl-NL/sales/start")
(dest / "corpus").mkdir()
(dest / "out").mkdir()
for i, c in enumerate(fixture["conversations"], start=1):
    chunks = [line for line in c["transcript"].splitlines() if line.strip()]
    (dest / "corpus" / f"{i:02d}-{c['id']}.json").write_text(json.dumps({
        "id": c["id"], "label": c["label"], "track": c["theme"], "language": lang,
        "start": f"2026-06-12T10:{i:02d}:00+02:00", "chunks": chunks,
    }, ensure_ascii=False))
(dest / "session.json").write_text(json.dumps({
    "slug": fixture["slug"], "organisation": fixture["organisation"], "synthetic": True,
    "public_sources_only": True, "title": {lang: fixture["title"]},
    "subtitle": {lang: fixture["subtitle"]},
}, ensure_ascii=False))
(dest / "research.md").write_text(Path("../demos/example/research.md").read_text())
(dest / "out" / f"state-{lang}.json").write_text(json.dumps(state, ensure_ascii=False))
(dest / "out" / f"settings-{lang}.json").write_text(json.dumps(settings, ensure_ascii=False))
`;
  writeFileSync(join(dir, "make.py"), program);
  // The server's settings load on import; the addresses are the ones run-old-api.sh uses.
  const env = {
    ...process.env,
    DIRECTUS_BASE_URL: "http://localhost:8065",
    DATABASE_URL: "postgresql+psycopg://dembrane:dembrane@localhost:5440/dembrane",
    REDIS_URL: "redis://localhost:6395",
    API_BASE_URL: "http://localhost:8100",
    ADMIN_BASE_URL: "http://localhost:5173",
    PARTICIPANT_BASE_URL: "http://localhost:5174",
    DISABLE_SENTRY: "1",
    STORAGE_S3_KEY: "parity",
    STORAGE_S3_SECRET: "parity",
    STORAGE_S3_BUCKET: "parity",
    STORAGE_S3_ENDPOINT: "http://127.0.0.1:9",
  };
  const r = Bun.spawnSync(
    ["zsh", "-lic", `uv run --frozen python ${join(dir, "make.py")} ${dir}`],
    {
      cwd: server,
      env,
    },
  );
  if (r.exitCode !== 0) throw new Error(`making the example folder failed: ${r.stderr}`);
  return dir;
}

function seed(args: string[], env: Record<string, string>): unknown {
  const cmd = `uv run --frozen python ${join(demos, "seed_demo.py")} ${args.join(" ")}`;
  const r = Bun.spawnSync(["zsh", "-lic", cmd], { cwd: server, env: { ...process.env, ...env } });
  if (r.exitCode !== 0) throw new Error(`seed_demo.py failed: ${r.stderr} ${r.stdout}`);
  const text = r.stdout.toString();
  return JSON.parse(text.slice(text.indexOf("{")));
}

/** What seed_demo.py --platform posted: the folder's inputs, read the same way. */
async function seedPlatform(folder: string, token: string): Promise<unknown> {
  const json = (path: string) => JSON.parse(readFileSync(join(folder, path), "utf8"));
  const session = json("session.json") as { title: Record<string, string> };
  const corpus = readdirSync(join(folder, "corpus"))
    .filter((f) => /^[0-9]{2}-.*\.json$/.test(f))
    .sort()
    .map((f) => json(`corpus/${f}`));
  const out = Object.fromEntries(
    Object.keys(session.title).map((language) => [
      language,
      {
        state: json(`out/state-${language}.json`),
        settings: json(`out/settings-${language}.json`),
      },
    ]),
  );
  const res = await fetch(`${NEW}/api/v2/admin/popcorn/demos`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      session,
      research: readFileSync(join(folder, "research.md"), "utf8"),
      corpus,
      out,
      sales_portal: JSON.parse(readFileSync(join(demos, "sales-portal.json"), "utf8")),
      workspace_id: workspaces.aDefault,
      owner_id: users.alice.directus,
      portal_base_url: "http://localhost:5174",
      api_base_url: NEW,
      dry_run: false,
    }),
  });
  if (!res.ok) throw new Error(`the platform refused the demo: ${res.status} ${await res.text()}`);
  return res.json();
}

const common = (folder: string, api: string) => [
  `--demo ${folder}`,
  "--portal-base-url http://localhost:5174",
  `--api-base-url ${api}`,
  `--workspace-id ${workspaces.aDefault}`,
  `--owner-id ${users.alice.directus}`,
];

/** The page and the bundle a public link serves, and the link's shape without its token. */
async function served(result: Record<string, unknown>) {
  const pages: Record<string, unknown> = {};
  for (const [language, v] of Object.entries(result)) {
    if (language === "sales_portals") continue;
    const link = (v as { public_link: string }).public_link;
    const page = await fetch(link).then(async (r) => [r.status, await r.text()]);
    const bundle = await fetch(`${link}data/bundle.json`).then(async (r) => [
      r.status,
      await r.json(),
    ]);
    pages[language] = { page, bundle };
  }
  return pages;
}

function shape(result: unknown): unknown {
  return JSON.parse(
    JSON.stringify(result).replace(
      /https?:\/\/[^/"]+\/api\/v2\/popcorn\/public\/[A-Za-z0-9_-]+\//g,
      "<api>/api/v2/popcorn/public/<token>/",
    ),
  );
}

const folder = exampleFolder();
const ignore = new Set(["public_token"]);

await reset();
let before = await snapshot();
const oldResult = seed([...common(folder, OLD), "--directus-url http://localhost:8065"], {
  DEMO_DIRECTUS_TOKEN: process.env.DIRECTUS_TOKEN ?? "",
});
const oldRows = diff(before, await snapshot());
const oldServed = await served(oldResult as Record<string, unknown>);
// A rerun updates the same rows and keeps the link.
before = await snapshot();
const oldAgain = seed([...common(folder, OLD), "--directus-url http://localhost:8065"], {
  DEMO_DIRECTUS_TOKEN: process.env.DIRECTUS_TOKEN ?? "",
});
const oldRerun = diff(before, await snapshot());

await reset();
await Bun.sleep(50);
const token = (await newToken("admin")) ?? "";
before = await snapshot();
const newResult = await seedPlatform(folder, token);
const newRows = diff(before, await snapshot());
const newServed = await served(newResult as Record<string, unknown>);
before = await snapshot();
const newAgain = await seedPlatform(folder, token);
const newRerun = diff(before, await snapshot());

const seedIds = new Set<string>();
const compare = (label: string, a: unknown, b: unknown) => {
  const x = JSON.stringify(normalize(a, seedIds, ignore), null, 1);
  const y = JSON.stringify(normalize(b, seedIds, ignore), null, 1);
  const same = x === y;
  out(`  ${same ? "ok  " : "FAIL"}  demo ${label}`);
  if (!same) {
    const base = `${here}.parity-out/popcorn_demo_${label.replace(/\W+/g, "_")}`;
    writeFileSync(`${base}.old.json`, x);
    writeFileSync(`${base}.new.json`, y);
  }
  return same;
};
const tables = (rows: typeof oldRows) =>
  Object.entries(Object.groupBy(rows, (r) => `${r.table} ${r.kind}`)).map(
    ([k, v]) => `${k}: ${v?.length}`,
  );
out(`old rows: ${tables(oldRows).join(", ")}`);
out(`new rows: ${tables(newRows).join(", ")}`);
const results = [
  compare("rows written", oldRows, newRows),
  compare("printed links", shape(oldResult), shape(newResult)),
  compare("public page and bundle", oldServed, newServed),
  compare("rerun rows", oldRerun, newRerun),
  JSON.stringify(oldAgain) === JSON.stringify(oldResult) &&
    JSON.stringify(newAgain) === JSON.stringify(newResult),
];
out(`\nold links: ${JSON.stringify(oldResult)}\nnew links: ${JSON.stringify(newResult)}`);
if (results.includes(false)) process.exit(1);
