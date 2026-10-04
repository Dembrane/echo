import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AudioError, type AudioErrorKind, noMergeableChunks } from "./errors";
import {
  concatFiles,
  convertFile,
  cutFile,
  durationOf,
  type ProbeResult,
  probeFile,
  probePlain,
  probeUrl,
} from "./ffmpeg";
import type { AudioFormat } from "./formats";

/** An object to read: a presigned GET URL and the format its name carries. */
export interface MediaSource {
  readonly url: string;
  readonly format: AudioFormat;
  /** The stored name, for error messages (merge reports failures per chunk). */
  readonly name?: string | undefined;
}

/** An object to write: a presigned PUT URL signed for this content type. */
export interface MediaTarget {
  readonly url: string;
  readonly contentType: string;
}

export interface MergeResult {
  /** Seconds, or -1 when the merged file could not be probed (as before). */
  readonly duration: number;
  readonly skipped: readonly { readonly name: string; readonly error: string }[];
}

/**
 * The ffmpeg work the pipeline hands over. Inputs and outputs are presigned URLs, so the
 * media service holds no bucket credentials and works against any S3 provider.
 */
export interface Media {
  probe(source: MediaSource): Promise<ProbeResult>;
  /** ffprobe straight on a URL, without a format hint (duration of an upload). */
  probeUrl(url: string): Promise<ProbeResult>;
  convert(req: {
    source: MediaSource;
    target: MediaTarget;
    outputFormat: "mp3" | "ogg";
  }): Promise<{ bytes: number }>;
  /** Cuts the source into pieces of the given start and length, each to its own target. */
  split(req: {
    source: MediaSource;
    pieces: readonly { start: number; duration: number; target: MediaTarget }[];
  }): Promise<void>;
  /**
   * Merges sources in order into one file: each is probed, converted when it is not
   * already in the output format, and skipped when it fails; all failing is an error.
   */
  merge(req: {
    sources: readonly MediaSource[];
    target: MediaTarget;
    outputFormat: "mp3" | "ogg";
  }): Promise<MergeResult>;
}

async function download(url: string, path: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new AudioError("transient", `download failed: ${(err as Error).message}`);
  }
  if (res.status === 404 || res.status === 403)
    throw new AudioError("transient", `download failed: ${res.status}`);
  if (!res.ok) throw new AudioError("transient", `download failed: ${res.status}`);
  await Bun.write(path, res);
  if (Bun.file(path).size === 0) throw new AudioError("value", "Input file is empty");
}

async function upload(target: MediaTarget, path: string): Promise<number> {
  const file = Bun.file(path);
  let res: Response;
  try {
    res = await fetch(target.url, {
      method: "PUT",
      headers: { "content-type": target.contentType },
      body: file,
    });
  } catch (err) {
    throw new AudioError("transient", `upload failed: ${(err as Error).message}`);
  }
  if (!res.ok)
    throw new AudioError("transient", `upload failed: ${res.status} ${await res.text()}`);
  return file.size;
}

async function inTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "echo-media-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Runs ffmpeg in this process: the media service itself, and local development. */
export class LocalMedia implements Media {
  probe(source: MediaSource) {
    return inTemp(async (dir) => {
      const p = join(dir, `input.${source.format}`);
      await download(source.url, p);
      return probeFile(p, source.format);
    });
  }

  probeUrl(url: string) {
    return probeUrl(url);
  }

  convert(req: { source: MediaSource; target: MediaTarget; outputFormat: "mp3" | "ogg" }) {
    return inTemp(async (dir) => {
      const input = join(dir, `input.${req.source.format}`);
      const output = join(dir, `output.${req.outputFormat}`);
      await download(req.source.url, input);
      await convertFile(input, req.source.format, output, req.outputFormat);
      return { bytes: await upload(req.target, output) };
    });
  }

  split(req: {
    source: MediaSource;
    pieces: readonly { start: number; duration: number; target: MediaTarget }[];
  }) {
    return inTemp(async (dir) => {
      const source = join(dir, `source.${req.source.format}`);
      await download(req.source.url, source);
      for (const [i, piece] of req.pieces.entries()) {
        const out = join(dir, `split_${i}.${req.source.format}`);
        await cutFile(source, out, req.source.format, piece.start, piece.duration);
        await upload(piece.target, out);
      }
    });
  }

  merge(req: {
    sources: readonly MediaSource[];
    target: MediaTarget;
    outputFormat: "mp3" | "ogg";
  }) {
    return inTemp(async (dir): Promise<MergeResult> => {
      const ready: string[] = [];
      const skipped: { name: string; error: string }[] = [];
      let transient = false;
      for (const [i, s] of req.sources.entries()) {
        const name = s.name ?? s.url;
        try {
          const input = join(dir, `in_${i}.${s.format}`);
          await download(s.url, input);
          const probe = await probeFile(input, s.format);
          const formatName = String(probe.format?.format_name ?? "").toLowerCase();
          if (formatName.includes(req.outputFormat)) ready.push(input);
          else {
            const converted = join(dir, `chunk_${i}.${req.outputFormat}`);
            await convertFile(input, s.format, converted, req.outputFormat);
            ready.push(converted);
          }
        } catch (err) {
          skipped.push({ name, error: (err as Error).message });
          // Bad bytes surface as probe or convert errors; anything else is transport
          // (storage, network) and a retry can still succeed.
          if (!(err instanceof AudioError && err.terminal)) transient = true;
        }
      }
      if (!ready.length) {
        if (transient)
          throw new AudioError(
            "transient",
            `No processed data streams: ${skipped.map((s) => s.error).join("; ")}`,
          );
        throw noMergeableChunks(
          skipped.map((s) => s.name),
          skipped.map((s) => s.error),
        );
      }
      const list = join(dir, "concat_list.txt");
      await Bun.write(list, ready.map((p) => `file '${p}'\n`).join(""));
      const merged = join(dir, `merged.${req.outputFormat}`);
      await concatFiles(list, merged, req.outputFormat);
      let duration = -1;
      try {
        duration = durationOf(await probePlain(merged)) ?? -1;
      } catch {
        duration = -1;
      }
      await upload(req.target, merged);
      return { duration, skipped };
    });
  }
}

/**
 * The worker's client for apps/media. Each call is one request the media service
 * handles alone on its instance; in Cloud Run the request carries an identity token
 * for the service's audience, so only the worker's service account can call it.
 */
export class HttpMedia implements Media {
  constructor(
    private readonly baseUrl: string,
    private readonly opts: {
      readonly timeoutMs: number;
      /** An ID token for the media service's URL; absent locally and with MEDIA_AUTH=none. */
      readonly idToken?: () => Promise<string>;
    },
  ) {}

  probe(source: MediaSource) {
    return this.call<ProbeResult>("probe", { source });
  }
  probeUrl(url: string) {
    return this.call<ProbeResult>("probe-url", { url });
  }
  convert(req: { source: MediaSource; target: MediaTarget; outputFormat: "mp3" | "ogg" }) {
    return this.call<{ bytes: number }>("convert", req);
  }
  async split(req: {
    source: MediaSource;
    pieces: readonly { start: number; duration: number; target: MediaTarget }[];
  }) {
    await this.call("split", req);
  }
  merge(req: {
    sources: readonly MediaSource[];
    target: MediaTarget;
    outputFormat: "mp3" | "ogg";
  }) {
    return this.call<MergeResult>("merge", req);
  }

  private async call<T>(op: string, body: unknown): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.opts.idToken) headers.authorization = `Bearer ${await this.opts.idToken()}`;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/${op}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      throw new AudioError("transient", `media ${op} unreachable: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (res.ok) return (text ? JSON.parse(text) : null) as T;
    let payload: { kind?: AudioErrorKind; message?: string } = {};
    try {
      payload = JSON.parse(text);
    } catch {}
    throw new AudioError(
      payload.kind ?? "transient",
      payload.message ?? `media ${op}: ${res.status}`,
    );
  }
}

/**
 * How callers prove themselves to the media service (MEDIA_AUTH). google_id_token is Cloud
 * Run's metadata-server token, so only the caller's service account gets in; none sends no
 * Authorization header, for a media service reachable only inside its cluster.
 */
export type MediaAuth = "google_id_token" | "none";

/** The HttpMedia auth options for a mode; spread into its options. */
export function mediaAuth(
  auth: MediaAuth,
  audience: string,
): { readonly idToken?: () => Promise<string> } {
  return auth === "google_id_token" ? { idToken: metadataIdToken(audience) } : {};
}

/** A Cloud Run identity token from the metadata server, cached until shortly before it expires. */
export function metadataIdToken(audience: string): () => Promise<string> {
  let cached: { token: string; until: number } | null = null;
  return async () => {
    if (cached && cached.until > Date.now()) return cached.token;
    const res = await fetch(
      `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}`,
      { headers: { "Metadata-Flavor": "Google" } },
    );
    if (!res.ok) throw new AudioError("transient", `identity token: ${res.status}`);
    const token = await res.text();
    // Tokens live an hour; refresh with ten minutes to spare.
    cached = { token, until: Date.now() + 50 * 60_000 };
    return token;
  };
}
