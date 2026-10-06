/**
 * Runs the popcorn eval: each case through the chain a tick runs (extract, shape, gates,
 * grounding, and with --validate the second pass's rooting), scored against the points
 * the case expects. Writes one JSON per case and repeat plus summary.md under
 * eval/runs/<label>/, and prints the summary.
 *
 *   bun eval/run.ts --label baseline [--repeat 3] [--validate] [--only id,id]
 *   bun eval/run.ts --label baseline --rescore    (scores a saved run again, no model calls)
 *   bun eval/run.ts --label try --prompt popcorn-v1.9    (another prompt file in prompts/)
 *
 * Calls go to Vertex with Application Default Credentials. LLM_VERTEX_PROJECT defaults to
 * dembrane-jorim-cli here. Set POPCORN_EVAL_CORPUS to a folder holding a cases.json whose
 * cases name a `file` in that folder, to add cases from real transcripts kept outside the repo.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
    rescore: { type: "boolean", default: false },
    prompt: { type: "string" },
  },
});
if (!args.label) throw new Error("--label is required");
const outDir = path.join(here, "runs", args.label);
if (args.rescore !== existsSync(outDir))
  throw new Error(args.rescore ? `${outDir} does not exist` : `${outDir} exists; pick a new label`);

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

interface Saved {
  case: string;
  run: number;
  prompt: string;
  head: string;
  model: string;
  raw: string[];
  shapedOut: string[];
  suppressed: { phrase: unknown; reason: unknown }[];
  unrooted: string[] | null;
  onScreen: string[];
  points?: unknown;
  row?: Row;
}

function score(c: EvalCase, saved: Saved): Saved {
  const points = scorePoints(c.points, saved.onScreen);
  const count = (s: string) => points.filter((r) => r.status === s).length;
  const row: Row = {
    id: c.id,
    run: saved.run,
    phrases: saved.onScreen.length,
    kept: count("kept"),
    thin: count("thin"),
    missing: count("missing"),
    longest: Math.max(0, ...saved.onScreen.map((p) => pySplit(p).length)),
    shapedOut: saved.shapedOut.length,
    suppressed: saved.suppressed.length,
    unrooted: saved.unrooted ? saved.unrooted.length : null,
    ...(c.expect?.min !== undefined && { min: c.expect.min }),
  };
  return { ...saved, points, row };
}

const write = (saved: Saved) =>
  writeFileSync(
    path.join(outDir, `${saved.case}.${saved.run}.json`),
    `${JSON.stringify(saved, null, 2)}\n`,
  );

const cases = loadCases().filter((c) => !args.only || args.only.split(",").includes(c.id));
const results: Saved[] = [];

if (args.rescore) {
  for (const f of readdirSync(outDir)
    .filter((n) => n.endsWith(".json"))
    .sort()) {
    const saved = JSON.parse(readFileSync(path.join(outDir, f), "utf8")) as Saved;
    const c = cases.find((x) => x.id === saved.case);
    if (!c) continue;
    const next = score(c, saved);
    write(next);
    results.push(next);
  }
} else {
  mkdirSync(outDir, { recursive: true });
  results.push(...(await runCases()));
}

async function runCases(): Promise<Saved[]> {
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
  const out: Saved[] = [];
  for (const c of cases) {
    const text = caseText(c);
    const tid = c.id;
    for (let run = 1; run <= Number(args.repeat); run++) {
      const raw = await model.extract({
        transcriptId: tid,
        transcript: text,
        hostNote: "",
        ...(args.prompt && { prompt: args.prompt }),
      });
      const rawPhrases = ((raw as { items?: { phrase?: string }[] }).items ?? []).map((i) =>
        String(i.phrase ?? ""),
      );
      const shaped = shapePopcornItems(raw, tid);
      const shapedSet = new Set(shaped.map((i) => String(i.phrase)));
      // What the shaper does to a phrase before judging it: whitespace, quotes, end marks.
      const tidy = (p: string) =>
        p
          .replace(/\s+/gu, " ")
          .replace(/^["'“”‘’]+|["'“”‘’]+$/gu, "")
          .trim()
          .replace(/[.!?;:]+$/u, "")
          .trim();
      const shapedOut = rawPhrases.filter((p) => !shapedSet.has(tidy(p)));
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
      const saved = score(c, {
        case: c.id,
        run,
        prompt: args.prompt ?? POPCORN_PROMPT,
        head,
        model: completer.modelIdentity("multi_modal_fast"),
        raw: rawPhrases,
        shapedOut,
        suppressed: suppressed.map((x) => ({ phrase: x.phrase, reason: x.reason })),
        unrooted,
        onScreen: items.map((i) => String(i.phrase)).filter((p) => !unrooted?.includes(p)),
      });
      write(saved);
      out.push(saved);
      process.stderr.write(`${c.id} #${run}: ${saved.row?.kept}/${c.points.length} kept\n`);
    }
  }
  return out;
}

const rows = results.map((r) => r.row as Row);
const first = results[0];
const runs = Math.max(0, ...rows.map((r) => r.run));
const validated = rows.some((r) => r.unrooted !== null);
const total = (k: "kept" | "thin" | "missing" | "phrases") => rows.reduce((n, r) => n + r[k], 0);
const lines = [
  `# ${args.label}`,
  "",
  `${first?.prompt} at ${first?.head}, ${first?.model}, ${runs} run(s)${validated ? ", with the second pass" : ""}.`,
  "",
  "| Case | Run | Popcorns | Kept | Thin | Missing | Longest (words) | Shaped out | Held by gates | Unrooted |",
  "|---|---|---|---|---|---|---|---|---|---|",
  ...rows.map(
    (r) =>
      `| ${r.id}${r.min !== undefined ? ` (needs ${r.min})` : ""} | ${r.run} | ${r.phrases} | ${r.kept} | ${r.thin} | ${r.missing} | ${r.longest} | ${r.shapedOut} | ${r.suppressed} | ${r.unrooted ?? "-"} |`,
  ),
  `| all | | ${total("phrases")} | ${total("kept")} | ${total("thin")} | ${total("missing")} | | | | |`,
  "",
  "| Case | Points | Kept (mean) | Thin (mean) | Missing (mean) | Runs with every point present |",
  "|---|---|---|---|---|---|",
  ...cases
    .filter((c) => rows.some((r) => r.id === c.id))
    .map((c) => {
      const mine = rows.filter((r) => r.id === c.id);
      const mean = (k: "kept" | "thin" | "missing") =>
        (mine.reduce((n, r) => n + r[k], 0) / mine.length).toFixed(1);
      const whole = mine.filter((r) => r.missing === 0).length;
      return `| ${c.id} | ${c.points.length} | ${mean("kept")} | ${mean("thin")} | ${mean("missing")} | ${whole}/${mine.length} |`;
    }),
  "",
];
writeFileSync(path.join(outDir, "summary.md"), lines.join("\n"));
process.stdout.write(lines.join("\n"));
