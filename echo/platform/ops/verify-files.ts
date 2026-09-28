/**
 * Compares the new bucket with the old Spaces bucket: object counts and bytes per top-level
 * prefix, the keys missing from the new side, and a checksum sample. Lists and reads both
 * sides; writes nothing. Exits non-zero when anything in the source is missing or differs.
 *
 *   SPACES_KEY=... SPACES_SECRET=... SOURCE_BUCKET=dbr-echo-prod-uploads \
 *   SINK_BUCKET=dembrane-echo-echo-prod-uploads GCS_TOKEN="$(gcloud auth print-access-token)" \
 *   bun ops/verify-files.ts [--sample 50] [--prefix audio-chunks/] [--json out.json]
 *
 * The checksum sample compares the Spaces ETag with the GCS MD5 when the ETag is an MD5
 * (single-part uploads); multipart objects are downloaded from both sides and hashed.
 * --exclude conversation_id/ skips prefixes the sync leaves behind on purpose.
 * With --manifest gs://.../delta.csv only the keys it lists are checked, by lookup.
 * Objects only the sink has are counted, not failed: files written by the new stack, or
 * deleted on Spaces after a pass.
 */
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : fallback;
};
const SAMPLE = Number(flag("--sample", "50"));
const PREFIX = flag("--prefix", "");
const JSON_OUT = flag("--json", "");
// A manifest (ops/files-manifest.sh) limits the check to its keys, looked up one by one
// instead of listing both buckets: the in-window check of the delta.
const MANIFEST = flag("--manifest", "");
// Prefixes left behind on purpose (files-sync.sh EXCLUDE_PREFIXES), comma-separated.
const EXCLUDE = flag("--exclude", "").split(",").filter(Boolean);
const excluded = (k: string) => EXCLUDE.some((p) => k.startsWith(p));

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};
const spaces = new Bun.S3Client({
  accessKeyId: env("SPACES_KEY"),
  secretAccessKey: env("SPACES_SECRET"),
  bucket: env("SOURCE_BUCKET"),
  endpoint: process.env.SPACES_ENDPOINT ?? "https://ams3.digitaloceanspaces.com",
  region: "us-east-1",
});
const sink = env("SINK_BUCKET");
const token = env("GCS_TOKEN");

interface Obj {
  size: number;
  md5: string | null; // hex; null when the source ETag is not an MD5 (multipart)
}

async function listSpaces(): Promise<Map<string, Obj>> {
  const out = new Map<string, Obj>();
  let continuationToken: string | undefined;
  do {
    const page = await spaces.list({
      prefix: PREFIX,
      maxKeys: 1000,
      ...(continuationToken ? { continuationToken } : {}),
    });
    for (const o of page.contents ?? []) {
      if (excluded(o.key)) continue;
      const etag = (o.eTag ?? "").replace(/"/g, "");
      out.set(o.key, { size: o.size ?? 0, md5: /^[0-9a-f]{32}$/.test(etag) ? etag : null });
    }
    continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
  } while (continuationToken);
  return out;
}

async function listGcs(): Promise<Map<string, Obj>> {
  const out = new Map<string, Obj>();
  let pageToken = "";
  do {
    const u = new URL(`https://storage.googleapis.com/storage/v1/b/${sink}/o`);
    u.searchParams.set("fields", "items(name,size,md5Hash),nextPageToken");
    u.searchParams.set("maxResults", "5000");
    if (PREFIX) u.searchParams.set("prefix", PREFIX);
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const res = await fetch(u, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`GCS list ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as {
      items?: { name: string; size: string; md5Hash?: string }[];
      nextPageToken?: string;
    };
    for (const o of (body.items ?? []).filter((o) => !excluded(o.name)))
      out.set(o.name, {
        size: Number(o.size),
        md5: o.md5Hash ? Buffer.from(o.md5Hash, "base64").toString("hex") : null,
      });
    pageToken = body.nextPageToken ?? "";
  } while (pageToken);
  return out;
}

async function gcsBytes(key: string): Promise<Uint8Array> {
  const u = `https://storage.googleapis.com/storage/v1/b/${sink}/o/${encodeURIComponent(key)}?alt=media`;
  const res = await fetch(u, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GCS get ${key}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const top = (k: string) => (k.includes("/") ? `${k.split("/")[0]}/` : "(root)");

async function manifestKeys(uri: string): Promise<string[]> {
  const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!m) throw new Error(`--manifest must be gs://bucket/object, got ${uri}`);
  const u = `https://storage.googleapis.com/storage/v1/b/${m[1]}/o/${encodeURIComponent(m[2] as string)}?alt=media`;
  const res = await fetch(u, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`manifest ${res.status}`);
  return (await res.text())
    .split("\n")
    .filter(Boolean)
    .map((l) => (l.startsWith('"') ? l.slice(1, -1).replace(/""/g, '"') : l));
}

async function lookup(keys: string[]): Promise<[Map<string, Obj>, Map<string, Obj>]> {
  const a = new Map<string, Obj>();
  const b = new Map<string, Obj>();
  const one = async (k: string) => {
    const st = await spaces
      .file(k)
      .stat()
      .catch(() => null);
    if (st) {
      const etag = (st.etag ?? "").replace(/"/g, "");
      a.set(k, { size: st.size, md5: /^[0-9a-f]{32}$/.test(etag) ? etag : null });
    }
    const res = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${sink}/o/${encodeURIComponent(k)}?fields=size,md5Hash`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (res.ok) {
      const o = (await res.json()) as { size: string; md5Hash?: string };
      b.set(k, {
        size: Number(o.size),
        md5: o.md5Hash ? Buffer.from(o.md5Hash, "base64").toString("hex") : null,
      });
    }
  };
  for (let i = 0; i < keys.length; i += 32) await Promise.all(keys.slice(i, i + 32).map(one));
  return [a, b];
}

const started = performance.now();
const [src, dst] = MANIFEST
  ? await lookup(await manifestKeys(MANIFEST))
  : await Promise.all([listSpaces(), listGcs()]);
const listedMs = Math.round(performance.now() - started);

const prefixes = new Map<
  string,
  { srcN: number; srcB: number; dstN: number; dstB: number; missing: number }
>();
const bucket = (k: string) => {
  const p = top(k);
  const e = prefixes.get(p) ?? { srcN: 0, srcB: 0, dstN: 0, dstB: 0, missing: 0 };
  prefixes.set(p, e);
  return e;
};
const missing: string[] = [];
const sizeDiff: string[] = [];
for (const [k, o] of src) {
  const e = bucket(k);
  e.srcN++;
  e.srcB += o.size;
  const d = dst.get(k);
  if (!d) {
    e.missing++;
    missing.push(k);
  } else if (d.size !== o.size) sizeDiff.push(k);
}
let sinkOnly = 0;
for (const [k, o] of dst) {
  const e = bucket(k);
  e.dstN++;
  e.dstB += o.size;
  if (!src.has(k)) sinkOnly++;
}

// A deterministic sample: the keys whose hash sorts first, so a rerun checks the same ones.
const both = [...src.keys()].filter((k) => dst.has(k));
const sample = both
  .map((k) => [createHash("md5").update(k).digest("hex"), k] as const)
  .sort()
  .slice(0, SAMPLE)
  .map(([, k]) => k);
const checksumBad: string[] = [];
let viaEtag = 0;
let viaDownload = 0;
for (const k of sample) {
  const a = src.get(k) as Obj;
  const b = dst.get(k) as Obj;
  if (a.md5 && b.md5) {
    viaEtag++;
    if (a.md5 !== b.md5) checksumBad.push(k);
    continue;
  }
  viaDownload++;
  const [x, y] = await Promise.all([spaces.file(k).bytes(), gcsBytes(k)]);
  if (sha(x) !== sha(y)) checksumBad.push(k);
}

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(2)} GiB`;
for (const [p, e] of [...prefixes].sort())
  console.log(
    `${p.padEnd(28)} source ${String(e.srcN).padStart(8)} ${gb(e.srcB).padStart(11)}   sink ${String(e.dstN).padStart(8)} ${gb(e.dstB).padStart(11)}   missing ${e.missing}`,
  );
for (const k of missing.slice(0, 20)) console.log(`missing ${k}`);
for (const k of sizeDiff.slice(0, 20)) console.log(`size-differs ${k}`);
for (const k of checksumBad) console.log(`checksum-differs ${k}`);
const total = (m: Map<string, Obj>) => [...m.values()].reduce((a, o) => a + o.size, 0);
const summary = {
  source: { objects: src.size, bytes: total(src) },
  sink: { objects: dst.size, bytes: total(dst) },
  missing: missing.length,
  sizeDiffers: sizeDiff.length,
  sinkOnly,
  sample: { checked: sample.length, viaEtag, viaDownload, differing: checksumBad.length },
  listedMs,
  totalMs: Math.round(performance.now() - started),
};
console.log(JSON.stringify(summary));
if (JSON_OUT)
  await Bun.write(JSON_OUT, JSON.stringify({ summary, missing, sizeDiff, checksumBad }, null, 2));
process.exit(missing.length || sizeDiff.length || checksumBad.length ? 1 : 0);
