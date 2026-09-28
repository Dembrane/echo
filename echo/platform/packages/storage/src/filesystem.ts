import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { checkKey, type ObjectStorage, type PresignedPost } from "./storage";

/** Where local presigned URLs point; served by `localStorageHandler`. */
export const LOCAL_STORAGE_PATH = "/_local-storage";

/**
 * Local development and tests. Presigned URLs point at the API's local file route, which
 * only exists when APP_ENV is local or test.
 */
export class FilesystemStorage implements ObjectStorage {
  /** Lets requireBucket tell a local store from a bucket without importing this class. */
  readonly kind = "filesystem";
  constructor(
    private readonly root: string,
    private readonly publicBase: string,
    /** The route prefix presigned URLs use; two local stores need two prefixes. */
    readonly routePath: string = LOCAL_STORAGE_PATH,
  ) {}

  private path(key: string) {
    return join(this.root, checkKey(key));
  }
  async put(key: string, body: Blob | ArrayBuffer | Uint8Array | string, _contentType?: string) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await Bun.write(p, body);
  }
  async get(key: string) {
    const f = Bun.file(this.path(key));
    return (await f.exists()) ? new Blob([await f.arrayBuffer()], { type: f.type }) : null;
  }
  exists(key: string) {
    return Bun.file(this.path(key)).exists();
  }
  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }
  async size(key: string) {
    const f = Bun.file(this.path(key));
    return (await f.exists()) ? f.size : null;
  }
  presignUpload(key: string, opts: { contentType: string; expiresInSeconds: number }) {
    return `${this.publicBase}${this.routePath}/${encodeURI(checkKey(key))}?expires=${Date.now() + opts.expiresInSeconds * 1000}`;
  }
  presignDownload(key: string, opts: { expiresInSeconds: number }) {
    return this.presignUpload(key, { contentType: "", expiresInSeconds: opts.expiresInSeconds });
  }
  presignPost(
    key: string,
    opts: { contentType: string; maxBytes: number; expiresInSeconds: number },
  ): PresignedPost {
    return {
      url: `${this.publicBase}${this.routePath}`,
      fields: {
        acl: "private",
        "Content-Type": opts.contentType,
        key: checkKey(key),
        expires: String(Date.now() + opts.expiresInSeconds * 1000),
      },
    };
  }
}

/**
 * The local stand-in for the bucket's HTTP surface: GET and PUT on a key, and the form
 * POST the portal uses. Mounted by the API only in local and test environments.
 */
export function localStorageHandler(storage: ObjectStorage, routePath = LOCAL_STORAGE_PATH) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (!url.pathname.startsWith(routePath)) return new Response(null, { status: 404 });
    const expires = Number(url.searchParams.get("expires") ?? Number.POSITIVE_INFINITY);
    const rest = decodeURI(url.pathname.slice(routePath.length + 1));
    try {
      if (req.method === "POST" && !rest) {
        const form = await req.formData();
        const key = String(form.get("key") ?? "");
        const file = form.get("file");
        if (Number(form.get("expires") ?? Number.POSITIVE_INFINITY) < Date.now())
          return new Response("expired", { status: 403 });
        if (!(file instanceof Blob)) return new Response("no file", { status: 400 });
        await storage.put(key, file, file.type);
        return new Response(null, { status: 204 });
      }
      if (expires < Date.now()) return new Response("expired", { status: 403 });
      if (req.method === "PUT") {
        await storage.put(rest, await req.arrayBuffer(), req.headers.get("content-type") ?? "");
        return new Response(null, { status: 200 });
      }
      if (req.method === "GET" || req.method === "HEAD") {
        const blob = await storage.get(rest);
        if (!blob) return new Response("not found", { status: 404 });
        return new Response(req.method === "HEAD" ? null : blob, {
          headers: { "content-length": String(blob.size) },
        });
      }
    } catch (err) {
      return new Response((err as Error).message, { status: 400 });
    }
    return new Response(null, { status: 405 });
  };
}
