import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId } from "@dembrane/core";
import { createDb } from "@dembrane/db";
import {
  FilesystemStorage,
  type ListedObject,
  type ObjectVersion,
  type Versioning,
} from "@dembrane/storage";
import postgres from "postgres";
import { AudioUrls } from "../src/audio-urls";
import {
  dryRun,
  execute,
  formatReport,
  type RetentionDeps,
  type RetentionStore,
} from "../src/retention";
import { admin, freshDatabase, quiet } from "./pipeline-harness";

const run = admin ? describe : describe.skip;
const DAY = 86_400_000;
const NOW = new Date("2026-11-03T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

/**
 * A bucket that keeps versions: a plain delete adds a marker and keeps the bytes, as on
 * DigitalOcean Spaces; only deleting a version removes it.
 */
class VersionedMemory implements RetentionStore {
  readonly kind = "memory";
  readonly log: string[] = [];
  failOn: string | null = null;
  private n = 0;
  readonly all = new Map<string, ObjectVersion[]>();
  constructor(private readonly state: Versioning = "enabled") {}
  async put(key: string, body: Blob | ArrayBuffer | Uint8Array | string) {
    const size = typeof body === "string" ? body.length : (body as Uint8Array).byteLength;
    const list = this.all.get(key) ?? [];
    this.all.set(key, [
      ...list.map((v) => ({ ...v, isLatest: false })),
      {
        key,
        size,
        versionId: `v${++this.n}`,
        isLatest: true,
        isDeleteMarker: false,
        lastModified: new Date(NOW.getTime() - this.n * DAY),
      },
    ]);
  }
  async get() {
    return null;
  }
  private current(key: string) {
    const v = this.all.get(key)?.find((x) => x.isLatest);
    return v && !v.isDeleteMarker ? v : null;
  }
  async exists(key: string) {
    return this.current(key) !== null;
  }
  async size(key: string) {
    return this.current(key)?.size ?? null;
  }
  async delete(key: string) {
    this.log.push(`delete ${key}`);
    const list = this.all.get(key) ?? [];
    this.all.set(key, [
      ...list.map((v) => ({ ...v, isLatest: false })),
      {
        key,
        size: 0,
        versionId: `m${++this.n}`,
        isLatest: true,
        isDeleteMarker: true,
        lastModified: NOW,
      },
    ]);
  }
  presignUpload(): string {
    throw new Error("unused");
  }
  presignDownload(): string {
    throw new Error("unused");
  }
  presignPost(): never {
    throw new Error("unused");
  }
  async versioning() {
    return this.state;
  }
  async *list(prefix: string): AsyncGenerator<ListedObject> {
    for (const key of [...this.all.keys()].sort())
      if (key.startsWith(prefix)) {
        const c = this.current(key);
        if (c) yield c;
      }
  }
  async *versions(prefix: string): AsyncGenerator<ObjectVersion> {
    for (const key of [...this.all.keys()].sort())
      if (key.startsWith(prefix)) yield* this.all.get(key) ?? [];
  }
  async deleteVersion(key: string, versionId: string) {
    if (this.failOn === key) throw new Error("bucket said no");
    this.log.push(`deleteVersion ${key} ${versionId}`);
    const rest = (this.all.get(key) ?? []).filter((v) => v.versionId !== versionId);
    if (rest.length) this.all.set(key, rest);
    else this.all.delete(key);
  }
  /** What the bucket holds, bytes and all. */
  held() {
    return [...this.all.values()].flat().length;
  }
}

run("audio retention", () => {
  setDefaultTimeout(60_000);
  let url: string;
  let sql: postgres.Sql;
  let database: ReturnType<typeof createDb>;
  const urls = new AudioUrls("https://s3.test", "bkt");
  const orgA = newId();
  const orgB = newId();
  const projA = newId();
  const projB = newId();
  const c = {
    deleted: newId(),
    shared: newId(),
    old: newId(),
    midA: newId(),
    midB: newId(),
    openOld: newId(),
    fresh: newId(),
    deletedB: newId(),
  };

  async function seedConversation(
    id: string,
    project: string,
    o: {
      deleted?: boolean;
      finished: boolean;
      lastAudioDaysAgo: number;
      chunks?: number;
      merged?: boolean;
      sharedMerged?: string;
    },
  ) {
    await sql`insert into conversation (id, project_id, participant_name, source, is_finished, deleted_at, merged_audio_path, created_at, updated_at)
      values (${id}, ${project}, 'P', 'PORTAL_AUDIO', ${o.finished}, ${o.deleted ? ago(1) : null},
        ${o.sharedMerged ?? (o.merged ? urls.fileUrl(`audio-conversations/merged-${id}-1.mp3`) : null)}, ${ago(o.lastAudioDaysAgo + 1)}, now())`;
    for (let i = 0; i < (o.chunks ?? 2); i++)
      await sql`insert into conversation_chunk (id, conversation_id, timestamp, created_at, path, transcript, source)
        values (${newId()}, ${id}, ${ago(o.lastAudioDaysAgo + (o.chunks ?? 2) - 1 - i)}, ${ago(o.lastAudioDaysAgo + (o.chunks ?? 2) - 1 - i)},
          ${urls.fileUrl(`conversation/${id}/chunks/${i}-a.mp3`)}, ${`words ${i}`}, 'PORTAL_AUDIO')`;
  }

  const fill = async (s: VersionedMemory, id: string, extra: string[] = []) => {
    for (let i = 0; i < 2; i++) {
      await s.put(`conversation/${id}/chunks/${i}-a.mp3`, "x".repeat(100));
      await s.put(`conversation/${id}/chunks/${i}-a.mp3`, "y".repeat(120)); // an older version behind it
    }
    await s.put(`conversation/${id}/chunks/0-a.webm`, "z".repeat(50)); // the original the mp3 was made from
    await s.put(`audio-conversations/merged-${id}-1.mp3`, "m".repeat(400));
    for (const k of extra) await s.put(k, "e".repeat(10));
  };

  beforeAll(async () => {
    url = await freshDatabase("conv_retention_test");
    database = createDb({ url, poolMax: 3 });
    sql = postgres(url, { max: 2, onnotice: () => {} });
    for (const [org, days, proj] of [
      [orgA, 60, projA],
      [orgB, null, projB],
    ] as const) {
      const billing = newId();
      const ws = newId();
      await sql`insert into org (id, name, audio_retention_days) values (${org}, ${org === orgA ? "Org A" : "Org B"}, ${days})`;
      await sql`insert into billing_account (id, org_id, tier) values (${billing}, ${org}, 'free')`;
      await sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'W', ${org}, ${billing})`;
      await sql`insert into project (id, name, workspace_id, is_conversation_allowed) values (${proj}, 'P', ${ws}, true)`;
    }
    await seedConversation(c.deleted, projA, {
      deleted: true,
      finished: true,
      lastAudioDaysAgo: 5,
      merged: true,
    });
    // A re-transcription clone points at the deleted conversation's merged recording.
    await seedConversation(c.shared, projA, {
      finished: true,
      lastAudioDaysAgo: 1,
      chunks: 1,
      sharedMerged: urls.fileUrl(`audio-conversations/merged-${c.deleted}-1.mp3`),
    });
    await seedConversation(c.old, projA, { finished: true, lastAudioDaysAgo: 100, merged: true });
    await seedConversation(c.midA, projA, { finished: true, lastAudioDaysAgo: 45 });
    await seedConversation(c.midB, projB, { finished: true, lastAudioDaysAgo: 45 });
    await seedConversation(c.openOld, projB, { finished: false, lastAudioDaysAgo: 200 });
    await seedConversation(c.fresh, projB, { finished: true, lastAudioDaysAgo: 3 });
    await seedConversation(c.deletedB, projB, {
      deleted: true,
      finished: false,
      lastAudioDaysAgo: 90,
      chunks: 1,
    });
  });
  afterAll(async () => {
    await sql?.end();
    await database?.close();
  });

  const bucket = async () => {
    const s = new VersionedMemory();
    for (const id of Object.values(c)) await fill(s, id);
    return s;
  };
  const deps = (audio: RetentionStore): RetentionDeps => ({
    db: database.db,
    audio,
    audioUrls: urls,
    logger: quiet,
    now: () => NOW,
  });
  const pathsOf = async (id: string) =>
    (
      await sql`select path from conversation_chunk where conversation_id = ${id} and path is not null`
    ).length;

  test("the dry run of the deleted step reports per organisation and changes nothing", async () => {
    const s = await bucket();
    const before = s.held();
    const report = await dryRun(deps(s), "deleted");
    expect(report.versioning).toBe("enabled");
    const a = report.orgs.find((o) => o.orgName === "Org A");
    const b = report.orgs.find((o) => o.orgName === "Org B");
    // Org A: the deleted conversation only. Its merged file is shared with a live clone, so it stays.
    expect(a?.conversations).toBe(1);
    expect(a?.heldBack).toBe(1);
    // two chunk mp3s, one webm original; the merged file is held back
    expect(a?.objects).toBe(3);
    expect(a?.bytes).toBe(120 * 2 + 50);
    // the older version of each mp3 (100 bytes each)
    expect(a?.noncurrentVersions).toBe(2);
    expect(a?.noncurrentBytes).toBe(200);
    expect(a?.oldest).toBeInstanceOf(Date);
    expect(b?.conversations).toBe(1);
    expect(s.held()).toBe(before);
    expect(s.log).toEqual([]);
    expect(await pathsOf(c.deleted)).toBe(2);
    expect(formatReport(report)).toContain("Nothing was removed.");
  });

  test("the aged step counts days from the last audio, per organisation, and leaves the rest", async () => {
    const report = await dryRun(deps(await bucket()), "aged");
    const a = report.orgs.find((o) => o.orgName === "Org A");
    const b = report.orgs.find((o) => o.orgName === "Org B");
    // Org A keeps 60 days: only the 100 day old conversation qualifies (the 45 day one and the clone do not).
    expect(a?.conversations).toBe(1);
    expect(a?.retentionDays).toBe(60);
    // Org B has no setting, so 30 days: the 45 day old one qualifies; the unfinished, the fresh and the deleted do not.
    expect(b?.conversations).toBe(1);
    expect(b?.retentionDays).toBe(30);
  });

  test("a database only dry run never opens the bucket", async () => {
    const never = new Proxy({} as RetentionStore, {
      get() {
        throw new Error("the bucket was used");
      },
    });
    const report = await dryRun(deps(never), "deleted", { dbOnly: true });
    expect(report.bucketRead).toBe(false);
    const a = report.orgs.find((o) => o.orgName === "Org A");
    expect(a?.pathsInRows).toBe(3);
    expect(a?.objects).toBeNull();
    expect(a?.oldest).toBeInstanceOf(Date);
  });

  test("a real run of the deleted step removes every version, keeps shared files and transcripts", async () => {
    const s = await bucket();
    const results = await execute(deps(s), "deleted");
    expect(results.map((r) => r.skipped)).toEqual([undefined, undefined]);
    const gone = (id: string) => [...s.all.keys()].filter((k) => k.includes(id));
    // Every object and every older version of the deleted conversation is gone, the original webm too.
    expect(gone(c.deletedB)).toEqual([]);
    expect(gone(c.deleted)).toEqual([`audio-conversations/merged-${c.deleted}-1.mp3`]);
    // Live conversations keep theirs, versions included.
    expect(gone(c.old).length).toBe(4);
    expect(s.all.get(`conversation/${c.old}/chunks/0-a.mp3`)?.length).toBe(2);
    // A plain delete would only have added a marker.
    expect(s.log.some((l) => l.startsWith("delete "))).toBe(false);
    // Rows lose the path and keep the transcript.
    expect(await pathsOf(c.deleted)).toBe(0);
    const rows =
      await sql`select transcript, path from conversation_chunk where conversation_id = ${c.deleted} order by transcript`;
    expect(rows.map((r) => r.transcript)).toEqual(["words 0", "words 1"]);
    const [shared] = await sql`select merged_audio_path from conversation where id = ${c.shared}`;
    expect(shared?.merged_audio_path).toContain("merged-");
    const [del] =
      await sql`select merged_audio_path, summary, deleted_at from conversation where id = ${c.deleted}`;
    expect(del?.merged_audio_path).not.toBeNull(); // shared with the clone, so it is still there
    expect(await pathsOf(c.old)).toBe(2);
    // A second run finds the paths gone and does nothing.
    const again = await execute(deps(s), "deleted");
    expect(again.every((r) => r.removed === 0)).toBe(true);
  });

  test("the aged step does not touch deleted conversations and stops where a bucket call fails", async () => {
    const s = await bucket();
    s.failOn = `conversation/${c.midB}/chunks/0-a.mp3`;
    const results = await execute(deps(s), "aged");
    const byId = new Map(results.map((r) => [r.conversationId, r]));
    expect(byId.get(c.old)?.skipped).toBeUndefined();
    expect(byId.get(c.midB)?.skipped).toBe("failed");
    expect(byId.get(c.midB)?.error).toBe("bucket said no");
    expect(byId.has(c.deleted)).toBe(false);
    // The failed conversation keeps its paths, so the next run finds it again.
    expect(await pathsOf(c.midB)).toBe(2);
    expect(await pathsOf(c.old)).toBe(0);
    expect([...s.all.keys()].some((k) => k.includes(c.old))).toBe(false);
    expect([...s.all.keys()].some((k) => k.includes(c.fresh))).toBe(true);
    s.failOn = null;
    const retry = await execute(deps(s), "aged");
    expect(retry.map((r) => r.conversationId)).toEqual([c.midB]);
    expect(await pathsOf(c.midB)).toBe(0);
  });

  test("an organisation's setting moves the line, and --org and --limit narrow a run", async () => {
    await sql`update org set audio_retention_days = 40 where id = ${orgA}`;
    try {
      const s = await bucket();
      const only = await dryRun(deps(s), "aged", { orgId: orgA });
      expect(only.orgs.map((o) => o.orgName)).toEqual(["Org A"]);
      expect(only.orgs[0]?.conversations).toBe(1); // the 45 day old conversation now qualifies; the 100 day old one went in the earlier run
      const one = await execute(deps(s), "aged", { orgId: orgA, limit: 1 });
      expect(one.length).toBe(1);
    } finally {
      await sql`update org set audio_retention_days = 60 where id = ${orgA}`;
    }
  });

  test("on an unversioned bucket a plain delete is the removal", async () => {
    const id = newId();
    await seedConversation(id, projB, {
      deleted: true,
      finished: true,
      lastAudioDaysAgo: 10,
      chunks: 2,
    });
    const root = mkdtempSync(join(tmpdir(), "echo-retention-"));
    const fs = new FilesystemStorage(root, "http://localhost");
    await fs.put(`conversation/${id}/chunks/0-a.mp3`, "abc");
    await fs.put(`conversation/${id}/chunks/1-a.mp3`, "abcd");
    const report = await dryRun(deps(fs), "deleted", { orgId: orgB });
    expect(report.versioning).toBe("off");
    expect(report.orgs[0]?.objects).toBe(2);
    expect(report.orgs[0]?.bytes).toBe(7);
    expect(report.orgs[0]?.noncurrentVersions).toBeNull();
    await execute(deps(fs), "deleted", { orgId: orgB });
    expect(await fs.exists(`conversation/${id}/chunks/0-a.mp3`)).toBe(false);
    expect(await pathsOf(id)).toBe(0);
  });
});
