#!/usr/bin/env bun
/**
 * Writes the trainable signals in DATABASE_URL as JSON lines, and counts what consent kept
 * out on stderr.
 *   bun run signals:export -- --out signals.jsonl [--since 2026-10-01] [--step verify]
 */
import { createDb } from "@dembrane/db";
import { trainableSignals } from "./export";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = arg("out");
if (!out) {
  process.stderr.write(
    "usage: signals:export --out <file.jsonl> [--since <date>] [--step <step>]\n",
  );
  process.exit(2);
}
const database = createDb({ url, poolMax: 1 });
try {
  const { rows, skipped } = await trainableSignals(database.db, {
    since: arg("since"),
    step: arg("step"),
  });
  await Bun.write(out, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
  process.stderr.write(
    `${rows.length} signals written to ${out}; skipped ${JSON.stringify(skipped)}\n`,
  );
} finally {
  await database.close();
}
