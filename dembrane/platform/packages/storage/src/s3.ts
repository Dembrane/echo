import { S3Client } from "bun";
import { postPolicyFields, signedHeaders } from "./sigv4";
import { checkKey, type ObjectStorage, type PresignedPost } from "./storage";

export interface S3Options {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /**
   * Prepended to every key, so several deployments can share one bucket and each can be
   * removed by its prefix (PR previews use pr-<n>/). Callers and stored paths use the bare
   * key; only requests to the bucket, presigned URLs included, carry the prefix.
   */
  readonly prefix?: string | undefined;
}

/** "pr-12" and "pr-12/" both become "pr-12/"; empty means no prefix. */
function normalizePrefix(prefix: string | undefined): string {
  if (!prefix) return "";
  const p = prefix.endsWith("/") ? prefix : `${prefix}/`;
  checkKey(p);
  if (p.includes("//")) throw new Error(`invalid storage prefix: ${JSON.stringify(prefix)}`);
  return p;
}

/** Bun's built-in S3 client: no SDK, streams bodies, signs presigned URLs locally. */
export class S3Storage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly prefix: string;
  constructor(private readonly opts: S3Options) {
    this.prefix = normalizePrefix(opts.prefix);
    this.client = new S3Client({
      endpoint: opts.endpoint,
      bucket: opts.bucket,
      region: opts.region,
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
    });
  }

  /** The object's key in the bucket. */
  private at(key: string): string {
    return this.prefix + checkKey(key);
  }

  async put(key: string, body: Blob | ArrayBuffer | Uint8Array | string, contentType?: string) {
    await this.client.write(this.at(key), body, contentType ? { type: contentType } : {});
  }
  async get(key: string) {
    const file = this.client.file(this.at(key));
    return (await file.exists()) ? new Blob([await file.arrayBuffer()], { type: file.type }) : null;
  }
  exists(key: string) {
    return this.client.exists(this.at(key));
  }
  async delete(key: string) {
    await this.client.delete(this.at(key));
  }
  async size(key: string) {
    return (await this.exists(key)) ? this.client.size(this.at(key)) : null;
  }
  /** CopyObject (Bun's client has none): path-style, header-signed, no bytes through the API. */
  async copy(from: string, to: string, opts: { timeoutMs?: number } = {}) {
    const path = (key: string) => `/${this.opts.bucket}/${encodeKey(this.at(key))}`;
    const url = new URL(`${this.opts.endpoint.replace(/\/$/, "")}${path(to)}`);
    const res = await fetch(url, {
      method: "PUT",
      signal: AbortSignal.timeout(opts.timeoutMs ?? COPY_TIMEOUT_MS),
      headers: signedHeaders({
        method: "PUT",
        url,
        headers: { "x-amz-copy-source": path(from) },
        region: this.opts.region,
        accessKeyId: this.opts.accessKeyId,
        secretAccessKey: this.opts.secretAccessKey,
        now: new Date(),
      }),
    });
    const body = await res.text();
    // S3 can answer 200 with an error body when a copy fails partway.
    if (!res.ok || body.includes("<Error>"))
      throw new Error(`copying ${from} to ${to} failed: ${res.status} ${body.slice(0, 200)}`);
  }
  presignUpload(key: string, opts: { contentType: string; expiresInSeconds: number }) {
    return this.client.presign(this.at(key), {
      method: "PUT",
      expiresIn: opts.expiresInSeconds,
      type: opts.contentType,
    });
  }
  presignDownload(key: string, opts: { expiresInSeconds: number }) {
    return this.client.presign(this.at(key), { method: "GET", expiresIn: opts.expiresInSeconds });
  }
  /** Path-style (endpoint/bucket), which every S3-compatible provider accepts. */
  presignPost(
    key: string,
    opts: { contentType: string; maxBytes: number; expiresInSeconds: number },
  ): PresignedPost {
    return {
      url: `${this.opts.endpoint.replace(/\/$/, "")}/${this.opts.bucket}`,
      fields: postPolicyFields({
        bucket: this.opts.bucket,
        key: this.at(key),
        contentType: opts.contentType,
        maxBytes: opts.maxBytes,
        expiresInSeconds: opts.expiresInSeconds,
        region: this.opts.region,
        accessKeyId: this.opts.accessKeyId,
        secretAccessKey: this.opts.secretAccessKey,
        now: new Date(),
      }),
    };
  }
}

// Under the API's 255 s idle timeout, leaving room to measure; a 2 GB server-side copy fits.
const COPY_TIMEOUT_MS = 120_000;

// RFC 3986 per segment, as SigV4 canonicalises S3 paths.
const encodeKey = (key: string) =>
  key
    .split("/")
    .map((seg) =>
      encodeURIComponent(seg).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
