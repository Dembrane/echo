import { S3Client } from "bun";
import { type Page, parseListing, parseVersioning, parseVersions } from "./listing";
import { encodeRfc3986, postPolicyFields, signedRequestHeaders } from "./sigv4";
import {
  checkKey,
  type ListedObject,
  type ObjectInventory,
  type ObjectStorage,
  type ObjectVersion,
  type PresignedPost,
  type Versioning,
} from "./storage";

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
  /** Replaces the global fetch for the signed listing and delete calls; tests only. */
  readonly fetch?: typeof fetch;
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
export class S3Storage implements ObjectStorage, ObjectInventory {
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

  /**
   * A header-signed call on the bucket, path-style like presignPost. Bun's S3 client lists
   * current objects only and cannot name a version, so these calls are signed here.
   */
  private async signed(
    method: "GET" | "DELETE",
    query: readonly (readonly [string, string])[],
    key?: string,
  ): Promise<Response> {
    const base = new URL(this.opts.endpoint);
    const path = `${base.pathname.replace(/\/$/, "")}/${this.opts.bucket}${
      key === undefined ? "" : `/${this.at(key).split("/").map(encodeRfc3986).join("/")}`
    }`;
    const headers = signedRequestHeaders({
      method,
      path,
      query,
      headers: { host: base.host },
      region: this.opts.region,
      accessKeyId: this.opts.accessKeyId,
      secretAccessKey: this.opts.secretAccessKey,
      now: new Date(),
    });
    const qs = query.map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`).join("&");
    const res = await (this.opts.fetch ?? fetch)(`${base.origin}${path}${qs ? `?${qs}` : ""}`, {
      method,
      headers,
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new Error(
        `${method} ${key ?? "bucket"} ${query.map((q) => q[0]).join("&")}: ${res.status} ${detail}`,
      );
    }
    return res;
  }

  /** Walks a paged listing; `start` carries the token or markers of the next page. */
  private async *pages<T>(
    params: readonly (readonly [string, string])[],
    parse: (xml: string) => Page<T>,
  ): AsyncGenerator<T> {
    let next: Readonly<Record<string, string>> | null = {};
    while (next) {
      const query: (readonly [string, string])[] = [...params, ...Object.entries(next)];
      const page: Page<T> = parse(await (await this.signed("GET", query)).text());
      yield* page.items;
      next = page.next;
    }
  }

  /** Bare keys: the deployment prefix is added to the request and taken off the answer. */
  async *list(prefix: string): AsyncGenerator<ListedObject> {
    const base = this.at(prefix);
    for await (const o of this.pages(
      [
        ["list-type", "2"],
        ["prefix", base],
      ],
      parseListing,
    ))
      if (o.key.startsWith(this.prefix)) yield { ...o, key: o.key.slice(this.prefix.length) };
  }

  async versioning(): Promise<Versioning> {
    return parseVersioning(await (await this.signed("GET", [["versioning", ""]])).text());
  }

  async *versions(prefix: string): AsyncGenerator<ObjectVersion> {
    if ((await this.versioning()) === "off") return;
    const base = this.at(prefix);
    for await (const v of this.pages(
      [
        ["versions", ""],
        ["prefix", base],
      ],
      parseVersions,
    ))
      if (v.key.startsWith(this.prefix)) yield { ...v, key: v.key.slice(this.prefix.length) };
  }

  async deleteVersion(key: string, versionId: string) {
    await this.signed("DELETE", [["versionId", versionId]], key);
  }
}
