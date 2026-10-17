#!/usr/bin/env bun
/**
 * Reads the JUnit report of a test run and fails when a file skipped tests it is not listed
 * for. A suite skips itself when what it needs is absent (a database template, a bucket, a
 * model); where the server checks provide it, a skip means the suite did not run.
 *   bun test --parallel --reporter=junit --reporter-outfile=tests.xml
 *   bun scripts/skipped-tests.ts tests.xml
 */
import { readFileSync } from "node:fs";

/** Files that may skip in the server checks, each with what it waits for. */
const MAY_SKIP: Readonly<Record<string, string>> = {
  "packages/accounts/test/demo-unit.test.ts": "a live site and model (ACCOUNTS_DEMO_LIVE)",
  "packages/agentic/test/agent.gemini.test.ts": "a live model (GOOGLE_APPLICATION_CREDENTIALS)",
  "packages/storage/test/s3.test.ts": "a real bucket (TEST_S3_*)",
};

const path = process.argv[2];
if (!path) throw new Error("usage: bun scripts/skipped-tests.ts <junit report>");
const report = readFileSync(path, "utf8");

// One chunk per test case, running to the next one: a skipped case holds a <skipped> element.
const cases = report.split("<testcase ").slice(1);
const skipped = new Map<string, number>();
for (const chunk of cases) {
  if (!chunk.includes("<skipped")) continue;
  const file = /\bfile="([^"]*)"/.exec(chunk)?.[1] ?? "(no file)";
  const key = file.replace(/^.*dembrane\/platform\//, "");
  skipped.set(key, (skipped.get(key) ?? 0) + 1);
}

const unexpected = [...skipped].filter(([file]) => !(file in MAY_SKIP)).sort();
if (cases.length === 0) {
  process.stderr.write(`${path} holds no test cases\n`);
  process.exit(1);
}
if (unexpected.length > 0) {
  process.stderr.write(
    "These files skipped tests; give them what they wait for, or list them in MAY_SKIP:\n",
  );
  for (const [file, count] of unexpected) process.stderr.write(`  ${file} (${count})\n`);
  process.exit(1);
}
process.stdout.write(`${cases.length} test cases; skips only in ${skipped.size} listed files\n`);
