import { S3Client } from "bun";
import { postPolicyFields } from "./sigv4";
import { checkKey, type ObjectStorage, type PresignedPost } from "./storage";

export interface S3Options {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** Bun's built-in S3 client: no SDK, streams bodies, signs presigned URLs locally. */
export class S3Storage implements ObjectStorage {
  private readonly client: S3Client;
  constructor(private readonly opts: S3Options) {
    this.client = new S3Client({
      endpoint: opts.endpoint,
      bucket: opts.bucket,
      region: opts.region,
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
    });
  }

  async put(key: string, body: Blob | ArrayBuffer | Uint8Array | string, contentType?: string) {
    await this.client.write(checkKey(key), body, contentType ? { type: contentType } : {});
  }
  async get(key: string) {
    const file = this.client.file(checkKey(key));
    return (await file.exists()) ? new Blob([await file.arrayBuffer()], { type: file.type }) : null;
  }
  exists(key: string) {
    return this.client.exists(checkKey(key));
  }
  async delete(key: string) {
    await this.client.delete(checkKey(key));
  }
  async size(key: string) {
    return (await this.exists(key)) ? this.client.size(checkKey(key)) : null;
  }
  presignUpload(key: string, opts: { contentType: string; expiresInSeconds: number }) {
    return this.client.presign(checkKey(key), {
      method: "PUT",
      expiresIn: opts.expiresInSeconds,
      type: opts.contentType,
    });
  }
  presignDownload(key: string, opts: { expiresInSeconds: number }) {
    return this.client.presign(checkKey(key), { method: "GET", expiresIn: opts.expiresInSeconds });
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
        key: checkKey(key),
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
