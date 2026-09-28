import { NotFoundError } from "@dembrane/core";
import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import type { ObjectStorage } from "@dembrane/storage";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

const { directus_files, directus_folders } = schema;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A file's folder and up to two parents, nearest first: the depth Directus's rules looked at. */
export type FolderChain = readonly string[];

/**
 * Directus's file read rules, kept as they were. Anyone may read logos and anything under a
 * "Public" folder (the portal shows the owner's logo before sign-in); signed-in users may
 * also read avatars; staff may read any file.
 */
export function mayRead(who: Signed | null, chain: FolderChain): boolean {
  if (who?.isStaff) return true;
  const [own] = chain;
  if (own?.includes("custom_logos")) return true;
  if (chain.some((name) => name.includes("Public"))) return true;
  return Boolean(who && own?.includes("avatars"));
}

async function folderChain(db: Db, folderId: string | null): Promise<string[]> {
  const names: string[] = [];
  let next = folderId;
  while (next && names.length < 3) {
    const [row] = await db
      .select({ name: directus_folders.name, parent: directus_folders.parent })
      .from(directus_folders)
      .where(eq(directus_folders.id, next))
      .limit(1);
    if (!row) break;
    names.push(row.name);
    next = row.parent;
  }
  return names;
}

/**
 * GET /api/assets/:file_id: the bytes Directus served at /assets/<id> for avatars and logos,
 * from the same bucket. Directus's resize parameters are ignored; the browser scales the
 * image. A file the caller may not read is reported missing, so ids cannot be probed.
 */
export function assetRoutes(deps: { db: Db; files: ObjectStorage }) {
  return new Hono<Env>().get("/api/assets/:file_id", async (c) => {
    const id = c.req.param("file_id");
    const missing = new NotFoundError("upload.file_not_found");
    if (!UUID.test(id)) throw missing;
    const [file] = await deps.db
      .select({
        disk: directus_files.filename_disk,
        type: directus_files.type,
        folder: directus_files.folder,
      })
      .from(directus_files)
      .where(eq(directus_files.id, id))
      .limit(1);
    if (!file?.disk) throw missing;
    const who = c.get("principal");
    if (!mayRead(who, await folderChain(deps.db, file.folder))) throw missing;
    const body = await deps.files.get(file.disk);
    if (!body) throw missing;
    return c.body(body.stream(), 200, {
      "content-type": file.type ?? (body.type || "application/octet-stream"),
      // Uploads get a fresh id, so a given id always names the same bytes.
      "cache-control": who ? "private, max-age=86400" : "public, max-age=86400",
      "x-content-type-options": "nosniff",
    });
  });
}
