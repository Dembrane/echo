#!/usr/bin/env bun
/**
 * Removes the audio the retention policy no longer allows, one step at a time. Without
 * --execute it only reports, per organisation, what the step would remove.
 *   bun run audio:retention deleted                  audio of conversations their owners deleted
 *   bun run audio:retention aged                     audio past the organisation's keep period
 *   bun run audio:retention <step> --execute         the real run of that step
 * Options: --org <id> one organisation, --limit <n> the first n conversations, --db-only
 * read the database and not the bucket, --concurrency <n>, --json for machine output.
 * Transcripts, summaries and chats stay. Needs the worker's database and audio bucket settings.
 */
import { loadSections } from "@dembrane/config";
import {
  AudioUrls,
  dryRun,
  execute,
  formatReport,
  RETENTION_STEPS,
  type RetentionStep,
} from "@dembrane/conversations";
import { createDb, withDatabase } from "@dembrane/db";
import { createLogger } from "@dembrane/observability";
import { FilesystemStorage, requireBucket, S3Storage } from "@dembrane/storage";

const USAGE =
  "usage: audio:retention <deleted|aged> [--execute] [--org <id>] [--limit <n>] [--db-only] [--concurrency <n>] [--json]\n";
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const step = args[0] as RetentionStep;
const number = (name: string) => {
  const v = flag(name);
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v) || Number(v) < 1)
    throw new Error(`${name} needs a whole number of 1 or more`);
  return Number(v);
};
if (!RETENTION_STEPS.includes(step)) {
  process.stderr.write(USAGE);
  process.exit(2);
}

const config = loadSections(["app", "database", "observability", "http", "audio"]).values;
const logger = createLogger({
  service: "echo-audio-retention",
  release: config.app.release,
  env: config.app.env,
  level: config.observability.logLevel,
});
const url = withDatabase(config.database.url, config.database.name);
const database = createDb({ url, poolMax: 2 });
const audio = config.audio.s3Bucket
  ? new S3Storage({
      endpoint: config.audio.s3Endpoint ?? "",
      bucket: config.audio.s3Bucket,
      region: config.audio.s3Region,
      accessKeyId: config.audio.s3AccessKeyId ?? "",
      secretAccessKey: config.audio.s3SecretAccessKey ?? "",
      prefix: config.audio.s3Prefix,
    })
  : new FilesystemStorage(config.audio.localRoot, config.http.publicUrl, "/_local-audio");
const out = (line: string) => process.stdout.write(`${line}\n`);

try {
  const dbOnly = args.includes("--db-only");
  if (!dbOnly) requireBucket(config.app.env, audio, "audio retention", "STORAGE_S3_BUCKET");
  const deps = {
    db: database.db,
    audio,
    audioUrls: new AudioUrls(
      config.audio.s3Endpoint ?? `${config.http.publicUrl}/_local-audio`,
      config.audio.s3Bucket ?? "local",
    ),
    logger,
    now: () => new Date(),
  };
  const options = {
    orgId: flag("--org"),
    limit: number("--limit"),
    concurrency: number("--concurrency"),
    dbOnly,
  };
  if (args.includes("--execute")) {
    const results = await execute(deps, step, options);
    for (const r of results)
      out(
        `${r.conversationId}\t${r.orgName}\t${r.skipped ?? "done"}\tobjects ${r.removed}\tversions ${r.versionsRemoved}\tbytes ${r.bytes}\tkept ${r.heldBack}${r.error ? `\t${r.error}` : ""}`,
      );
    const done = results.filter((r) => !r.skipped);
    out(
      `step ${step}: ${done.length} conversations done, ${results.length - done.length} skipped; ${done.reduce((a, r) => a + r.removed, 0)} objects, ${done.reduce((a, r) => a + r.versionsRemoved, 0)} versions, ${done.reduce((a, r) => a + r.bytes, 0)} bytes removed`,
    );
    if (results.some((r) => r.skipped === "failed")) process.exitCode = 1;
  } else {
    const report = await dryRun(deps, step, options);
    out(args.includes("--json") ? JSON.stringify(report, null, 2) : formatReport(report));
  }
} finally {
  await database.close();
}
