/**
 * Runs the popcorn eval: each case through the chain a tick runs (extract, shape, gates,
 * grounding, and with --validate the second pass's rooting), scored against the points
 * the case expects. Writes one JSON per case and repeat plus summary.md under
 * eval/runs/<label>/, and prints the summary.
 *
 *   bun --env-file=../../.env.local eval/run.ts --label baseline [--repeat 3] [--validate] [--only id,id]
 *
 * Calls go to Vertex with Application Default Credentials. LLM_VERTEX_PROJECT defaults to
 * dembrane-jorim-cli here. Set POPCORN_EVAL_CORPUS to a folder holding a cases.json whose
 * cases name a `file` in that folder, to add cases from real transcripts kept outside the repo.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { loadSections } from "@dembrane/config";
import { createModels, vertexCompleter } from "@dembrane/llm";
import { pySplit } from "../src/text";
import { evidenceFrom } from "../src/tick/enrichment";
import { gateItems, introducedNames } from "../src/tick/flags";
import { groundItems } from "../src/tick/grounding";
import { POPCORN_PROMPT, PopcornModel } from "../src/tick/model";
import { shapePopcornItems } from "../src/tick/shapes";
import { type EvalPoint, scorePoints } from "./score";

interface EvalCase {
  id: string;
  title: string;
  text?: string;
  millbrook?: string;
  file?: string;
  expect?: { min?: number };
  points: EvalPoint[];
}

const here = import.meta.dir;
const { values: args } = parseArgs({
  options: {
    label: { type: "string" },
    repeat: { type: "string", default: "1" },
    validate: { type: "boolean", default: false },
    only: { type: "string" },
  },
});
if (!args.label) throw new Error("--label is required");
const outDir = path.join(here, "runs", args.label);
if (existsSync(outDir)) throw new Error(`${outDir} exists; pick a new label`);

function loadCases(): EvalCase[] {
  const own = JSON.parse(readFileSync(path.join(here, "cases.json"), "utf8")).cases as EvalCase[];
  const corpus = process.env.POPCORN_EVAL_CORPUS;
  if (!corpus) return own;
  const extra = JSON.parse(readFileSync(path.join(corpus, "cases.json"), "utf8"))
    .cases as EvalCase[];
  return [...own, ...extra.map((c) => (c.file ? { ...c, file: path.join(corpus, c.file) } : c))];
}

const millbrook = new Map<string, string>(
  (
    JSON.parse(
      readFileSync(path.join(here, "../../samples/fixtures/millbrook/conversations.json"), "utf8"),
    ) as { key: string; chunks: { text: string }[] }[]
  ).map((c) => [c.key, c.chunks.map((x) => x.text).join("\n")]),
);

function caseText(c: EvalCase): string {
  if (c.text) return c.text;
  if (c.millbrook) {
    const t = millbrook.get(c.millbrook);
    if (!t) throw new Error(`no Millbrook conversation ${c.millbrook}`);
    return t;
  }
  if (c.file) return readFileSync(c.file, "utf8").trim();
  throw new Error(`case ${c.id} has no text`);
}

const { values } = loadSections(["llm"], {
  LLM_VERTEX_PROJECT: "dembrane-jorim-cli",
  ...process.env,
});
const groups = {
  text_fast: values.llm.textFast,
  multi_modal_fast: values.llm.multiModalFast,
  multi_modal_pro: values.llm.multiModalPro,
};
const completer = vertexCompleter(
  createModels({
    vertexProject: values.llm.vertexProject,
    vertexLocation: values.llm.vertexLocation,
    groups,
    embeddingModel: values.llm.embeddingModel,
    embeddingLocation: values.llm.embeddingLocation,
    embeddingDimensions: values.llm.embeddingDimensions,
  }),
  { groups },
);
const model = new PopcornModel(completer);

const sh = (cmd: string) => execSync(cmd, { cwd: here, encoding: "utf8" }).trim();
const head = `${sh("git rev-parse --short HEAD")}${sh("git status --porcelain -- ..") ? "+dirty" : ""}`;

const cases = loadCases().filter((c) => !args.only || args.only.split(",").includes(c.id));
const repeat = Number(args.repeat);
mkdirSync(outDir, { recursive: true });

interface Row {
  id: string;
  run: number;
  phrases: number;
  kept: number;
  thin: number;
  missing: number;
  longest: number;
  shapedOut: number;
  suppressed: number;
  unrooted: number | null;
  min?: number;
}
const rows: Row[] = [];

for (const c of cases) {
  const text = caseText(c);
  const tid = c.id;
  for (let run = 1; run <= repeat; run++) {
    const raw = await model.extract({ transcriptId: tid, transcript: text, hostNote: "" });
    const rawPhrases = ((raw as { items?: { phrase?: string }[] }).items ?? []).map((i) =>
      String(i.phrase ?? ""),
    );
    const shaped = shapePopcornItems(raw, tid);
    const shapedSet = new Set(shaped.map((i) => String(i.phrase)));
    const shapedOut = rawPhrases.filter((p) => !shapedSet.has(p.replace(/[.!?;:]+$/u, "").trim()));
    const [kept, suppressed] = gateItems(shaped, introducedNames(text), new Set());
    const items = groundItems(kept, text);
    let unrooted: string[] | null = null;
    if (args.validate) {
      unrooted = [];
      for (const item of items) {
        const phrase = String(item.phrase);
        const answer = await model.validate({ transcriptId: tid, transcript: text, phrase });
        if (!evidenceFrom(answer, phrase, text).grounded) unrooted.push(phrase);
      }
    }
    const onScreen = items.map((i) => String(i.phrase)).filter((p) => !unrooted?.includes(p));
    const scored = scorePoints(c.points, onScreen);
    const count = (s: string) => scored.filter((r) => r.status === s).length;
    const row: Row = {
      id: c.id,
      run,
      phrases: onScreen.length,
      kept: count("kept"),
      thin: count("thin"),
      missing: count("missing"),
      longest: Math.max(0, ...onScreen.map((p) => pySplit(p).length)),
      shapedOut: shapedOut.length,
      suppressed: suppressed.length,
      unrooted: unrooted ? unrooted.length : null,
      ...(c.expect?.min !== undefined && { min: c.expect.min }),
    };
    rows.push(row);
    writeFileSync(
      path.join(outDir, `${c.id}.${run}.json`),
      `${JSON.stringify(
        {
          case: c.id,
          run,
          prompt: POPCORN_PROMPT,
          head,
          model: completer.modelIdentity("multi_modal_fast"),
          raw: rawPhrases,
          shapedOut,
          suppressed: suppressed.map((s) => ({ phrase: s.phrase, reason: s.reason })),
          unrooted,
          onScreen,
          points: scored,
          row,
        },
        null,
        2,
      )}\n`,
    );
    process.stderr.write(`${c.id} #${run}: ${row.kept}/${c.points.length} kept\n`);
  }
}

const total = (k: "kept" | "thin" | "missing" | "phrases") => rows.reduce((n, r) => n + r[k], 0);
const lines = [
  `# ${args.label}`,
  "",
  `${POPCORN_PROMPT} at ${head}, ${completer.modelIdentity("multi_modal_fast")}, ${repeat} run(s)${args.validate ? ", with the second pass" : ""}.`,
  "",
  "| Case | Run | Popcorns | Kept | Thin | Missing | Longest (words) | Shaped out | Held by gates | Unrooted |",
  "|---|---|---|---|---|---|---|---|---|---|",
  ...rows.map(
    (r) =>
      `| ${r.id}${r.min !== undefined ? ` (needs ${r.min})` : ""} | ${r.run} | ${r.phrases} | ${r.kept} | ${r.thin} | ${r.missing} | ${r.longest} | ${r.shapedOut} | ${r.suppressed} | ${r.unrooted ?? "-"} |`,
  ),
  `| all | | ${total("phrases")} | ${total("kept")} | ${total("thin")} | ${total("missing")} | | | | |`,
  "",
];
writeFileSync(path.join(outDir, "summary.md"), lines.join("\n"));
process.stdout.write(lines.join("\n"));
