import type { Db } from "@dembrane/db";
import type { Logger } from "@dembrane/observability";
import type { ObjectInventory, ObjectStorage } from "@dembrane/storage";
import type { AudioUrls } from "../audio-urls";
import {
  type Candidate,
  clearPaths,
  pathsHeldElsewhere,
  type RetentionStep,
  type SelectOptions,
  selectCandidates,
} from "./select";

export type RetentionStore = ObjectStorage & ObjectInventory;

export interface RetentionDeps {
  readonly db: Db;
  readonly audio: RetentionStore;
  readonly audioUrls: AudioUrls;
  readonly logger: Logger;
  readonly now: () => Date;
}

export interface RetentionOptions extends SelectOptions {
  /** Read only the database: no bucket access, so bytes and versions are not counted. */
  readonly dbOnly?: boolean | undefined;
  /** At most this many conversations, in organisation order. */
  readonly limit?: number | undefined;
  /** Conversations scanned at once. */
  readonly concurrency?: number | undefined;
}

/** What one stored key holds: its current object and every older version. */
export interface FoundObject {
  readonly key: string;
  /** Bytes and time of the current object; null when only older versions or a delete marker remain. */
  readonly current: { readonly size: number; readonly at: Date | null } | null;
  readonly versions: {
    readonly id: string;
    readonly size: number;
    readonly at: Date | null;
    readonly current: boolean;
    readonly marker: boolean;
  }[];
}

/** The folders that hold a conversation's audio, whatever the rows say. */
export const conversationPrefixes = (conversationId: string) => [
  `conversation/${conversationId}/`,
  `chunks/${conversationId}/`,
  `audio-conversations/merged-${conversationId}-`,
];

const collect = async <T>(it: AsyncIterable<T>) => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

/** Keys the rows name, as keys of this bucket; a path that cannot be read is returned apart. */
export function keysOf(audioUrls: AudioUrls, paths: readonly string[]) {
  const keys = new Map<string, string[]>();
  const unreadable: string[] = [];
  for (const p of paths)
    try {
      const key = audioUrls.keyOf(p);
      keys.set(key, [...(keys.get(key) ?? []), p]);
    } catch {
      unreadable.push(p);
    }
  return { keys, unreadable };
}

/** The keys of one conversation that no other live row points at, with the keys others hold. */
async function ownKeys(d: RetentionDeps, c: Candidate) {
  const { keys } = keysOf(d.audioUrls, c.paths);
  const held = await pathsHeldElsewhere(d.db, c.conversationId, c.paths);
  const heldKeys = new Set(
    [...keys].filter(([, ps]) => ps.some((p) => held.has(p))).map(([k]) => k),
  );
  return { keys, heldKeys, heldPaths: held };
}

/**
 * Everything the bucket holds for one conversation: the objects under its own folders plus
 * every key its rows name (older recordings sit elsewhere), each with its old versions.
 * Where the bucket keeps versions the version list is the truth, since an object whose
 * current version is a delete marker no longer shows in a plain listing.
 */
export async function scanConversation(
  store: ObjectInventory,
  c: Candidate,
  keys: Iterable<string>,
  versioned: boolean,
): Promise<FoundObject[]> {
  const found = new Map<
    string,
    { current: FoundObject["current"]; versions: FoundObject["versions"] }
  >();
  const entry = (key: string) => {
    const e = found.get(key) ?? { current: null, versions: [] };
    found.set(key, e);
    return e;
  };
  const read = async (prefix: string, exact: boolean) => {
    for (const o of await collect(store.list(prefix)))
      if (!exact || o.key === prefix) entry(o.key).current = { size: o.size, at: o.lastModified };
    if (versioned)
      for (const v of await collect(store.versions(prefix)))
        if (!exact || v.key === prefix)
          entry(v.key).versions.push({
            id: v.versionId,
            size: v.size,
            at: v.lastModified,
            current: v.isLatest,
            marker: v.isDeleteMarker,
          });
  };
  for (const prefix of conversationPrefixes(c.conversationId)) await read(prefix, false);
  for (const key of keys) if (!found.has(key)) await read(key, true);
  return [...found].map(([key, e]) => ({ key, ...e }));
}

/** One organisation's line in the dry run. */
export interface OrgReport {
  readonly orgId: string | null;
  readonly orgName: string;
  readonly retentionDays: number;
  readonly conversations: number;
  /** Chunk paths and merged recordings the rows hold. */
  readonly pathsInRows: number;
  /** Current objects in the bucket, and their bytes; null when the bucket was not read. */
  readonly objects: number | null;
  readonly bytes: number | null;
  /** Older versions and delete markers behind those keys, on a versioned bucket. */
  readonly noncurrentVersions: number | null;
  readonly noncurrentBytes: number | null;
  /** Oldest object (bucket time) or, without the bucket, oldest chunk the rows record. */
  readonly oldest: Date | null;
  /** Rows' paths that other live rows share, so a run would leave them. */
  readonly heldBack: number;
}

export interface RetentionReport {
  readonly step: RetentionStep;
  readonly generatedAt: Date;
  readonly bucketRead: boolean;
  readonly versioning: "enabled" | "suspended" | "off" | null;
  readonly orgs: OrgReport[];
}

type Mut<T> = { -readonly [K in keyof T]: T[K] };

const earliest = (...d: (Date | null | undefined)[]) => {
  const t = d.flatMap((x) => (x ? [x.getTime()] : []));
  return t.length ? new Date(Math.min(...t)) : null;
};

async function pool<T, R>(
  items: readonly T[],
  size: number,
  fn: (x: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
      for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i] as T);
    }),
  );
  return out;
}

/** Candidates for a step, limited as the options say. */
async function pick(d: RetentionDeps, step: RetentionStep, o: RetentionOptions) {
  const all = await selectCandidates(d.db, step, d.now(), o);
  return o.limit === undefined ? all : all.slice(0, o.limit);
}

/**
 * The dry run: per organisation, what a real run of the step would remove. Reads the
 * database and, unless `dbOnly`, lists the bucket; it changes nothing anywhere.
 */
export async function dryRun(
  d: RetentionDeps,
  step: RetentionStep,
  o: RetentionOptions = {},
): Promise<RetentionReport> {
  const picked = await pick(d, step, o);
  const versioning = o.dbOnly ? null : await d.audio.versioning();
  const versioned = versioning === "enabled" || versioning === "suspended";
  const scanned = await pool(picked, o.concurrency ?? 8, async (c) => {
    if (o.dbOnly) return { c, held: new Set<string>(), found: null };
    const { keys, heldKeys, heldPaths } = await ownKeys(d, c);
    const found = (await scanConversation(d.audio, c, keys.keys(), versioned)).filter(
      (f) => !heldKeys.has(f.key),
    );
    return { c, held: heldPaths, found };
  });

  const mutable = new Map<string, Mut<OrgReport>>();
  for (const { c, held, found } of scanned) {
    const id = c.orgId ?? "none";
    const r: Mut<OrgReport> = mutable.get(id) ?? {
      orgId: c.orgId,
      orgName: c.orgName,
      retentionDays: c.retentionDays,
      conversations: 0,
      pathsInRows: 0,
      objects: found ? 0 : null,
      bytes: found ? 0 : null,
      noncurrentVersions: found && versioned ? 0 : null,
      noncurrentBytes: found && versioned ? 0 : null,
      oldest: null,
      heldBack: 0,
    };
    mutable.set(id, r);
    r.conversations += 1;
    r.pathsInRows += c.paths.length;
    r.heldBack += held.size;
    r.oldest = earliest(r.oldest, found ? undefined : c.oldestChunkAt);
    for (const f of found ?? []) {
      if (f.current) {
        r.objects = (r.objects ?? 0) + 1;
        r.bytes = (r.bytes ?? 0) + f.current.size;
        r.oldest = earliest(r.oldest, f.current.at);
      }
      for (const v of f.versions) {
        r.oldest = earliest(r.oldest, v.at);
        if (v.current && !v.marker) continue;
        r.noncurrentVersions = (r.noncurrentVersions ?? 0) + 1;
        r.noncurrentBytes = (r.noncurrentBytes ?? 0) + v.size;
      }
    }
  }
  return {
    step,
    generatedAt: d.now(),
    bucketRead: !o.dbOnly,
    versioning,
    orgs: [...mutable.values()].sort((a, b) => a.orgName.localeCompare(b.orgName)),
  };
}

export interface ConversationResult {
  readonly conversationId: string;
  readonly orgName: string;
  readonly removed: number;
  readonly versionsRemoved: number;
  readonly bytes: number;
  readonly heldBack: number;
  readonly rowsCleared: number;
  readonly skipped?: "no longer a candidate" | "failed";
  readonly error?: string;
}

/**
 * The real run of one step. Per conversation: look again that it still qualifies, take
 * every object and, on a versioned bucket, every version and delete marker of each key,
 * and only when all of them are gone clear the paths in the rows. A failure leaves that
 * conversation's rows as they were, so the next run finds it again. Files that other live
 * rows point at are left alone.
 */
export async function execute(
  d: RetentionDeps,
  step: RetentionStep,
  o: RetentionOptions = {},
): Promise<ConversationResult[]> {
  if (o.dbOnly) throw new Error("a real run needs the bucket: do not combine it with db-only");
  const versioning = await d.audio.versioning();
  const versioned = versioning === "enabled" || versioning === "suspended";
  const picked = await pick(d, step, o);
  return pool(picked, o.concurrency ?? 4, async (planned): Promise<ConversationResult> => {
    const base = { conversationId: planned.conversationId, orgName: planned.orgName };
    try {
      const [c] = await selectCandidates(d.db, step, d.now(), {
        conversationIds: [planned.conversationId],
      });
      if (!c)
        return {
          ...base,
          removed: 0,
          versionsRemoved: 0,
          bytes: 0,
          heldBack: 0,
          rowsCleared: 0,
          skipped: "no longer a candidate",
        };
      const { keys, heldKeys, heldPaths } = await ownKeys(d, c);
      const found = (await scanConversation(d.audio, c, keys.keys(), versioned)).filter(
        (f) => !heldKeys.has(f.key),
      );
      let removed = 0;
      let versionsRemoved = 0;
      let bytes = 0;
      for (const f of found) {
        // A plain delete on a versioned bucket only adds a marker and keeps the bytes.
        if (versioned) for (const v of f.versions) await d.audio.deleteVersion(f.key, v.id);
        else await d.audio.delete(f.key);
        if (await d.audio.exists(f.key)) throw new Error(`still stored after delete: ${f.key}`);
        removed += f.current ? 1 : 0;
        versionsRemoved += f.versions.length;
        bytes += f.current?.size ?? 0;
      }
      const gone = new Set([...keys].filter(([k]) => !heldKeys.has(k)).flatMap(([, ps]) => ps));
      const cleared = await clearPaths(d.db, c.conversationId, gone);
      d.logger.info(
        {
          signal: "audio.retention",
          step,
          conversationId: c.conversationId,
          orgId: c.orgId,
          removed,
          versionsRemoved,
          bytes,
          heldBack: heldPaths.size,
        },
        "audio removed",
      );
      return {
        ...base,
        removed,
        versionsRemoved,
        bytes,
        heldBack: heldPaths.size,
        rowsCleared: cleared.chunks + (cleared.merged ? 1 : 0),
      };
    } catch (err) {
      d.logger.error(
        { err, step, conversationId: planned.conversationId },
        "audio retention failed for a conversation",
      );
      return {
        ...base,
        removed: 0,
        versionsRemoved: 0,
        bytes: 0,
        heldBack: 0,
        rowsCleared: 0,
        skipped: "failed",
        error: (err as Error).message,
      };
    }
  });
}
