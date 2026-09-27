import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { checkKey, type ObjectStorage } from "./storage";

/**
 * Local development and tests. Presigned URLs point at the API's local file route, which
 * only exists when APP_ENV is local or test.
 */
export class FilesystemStorage implements ObjectStorage {
  constructor(
    private readonly root: string,
    private readonly publicBase: string,
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
    return `${this.publicBase}/_local-storage/${encodeURI(checkKey(key))}?expires=${Date.now() + opts.expiresInSeconds * 1000}`;
  }
  presignDownload(key: string, opts: { expiresInSeconds: number }) {
    return this.presignUpload(key, { contentType: "", expiresInSeconds: opts.expiresInSeconds });
  }
}
