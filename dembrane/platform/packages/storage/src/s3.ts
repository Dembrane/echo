import { S3Client } from "bun";
import { postPolicyFields } from "./sigv4";
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
