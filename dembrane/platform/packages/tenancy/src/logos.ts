import { BadRequestError, newId, UnavailableError } from "@dembrane/core";
import type { ObjectStorage } from "@dembrane/storage";
import { type Conn, iso, isUuid } from "./db";
import { deleteFile, fileDiskName, folderByName, insertFile, insertFolder } from "./storage/files";

/**
 * Raster only: files are served same-origin, and an SVG can carry script. 5 MB is far above
 * any real logo; bigger is almost always a misfired upload.
 */
const ALLOWED = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);
const MAX_BYTES = 5 * 1024 * 1024;
const EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpeg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
};

/**
 * Where logos live. Objects are keyed the way Directus names files on disk (`<id><ext>`)
 * and each gets a directus_files row in the `custom_logos` folder, so the stored file id
 * keeps resolving through /assets/<id> while Directus still serves assets.
 */
export interface LogoStore {
  readonly objects: ObjectStorage;
  /** The Directus storage location name the bucket is registered under. */
  readonly location: string;
}

/** Only bare file ids are ours to delete; http(s) URLs from older rows are someone else's. */
export function isOwnedFile(value: string | null | undefined): value is string {
  return Boolean(value) && !/^https?:\/\//i.test(value ?? "");
}

export function checkLogoFile(file: File): File {
  if (file.type && !ALLOWED.has(file.type))
    throw new BadRequestError("upload.unsupported_type", {
      message: "Logo must be PNG, JPEG, or WebP",
      params: { accepted: "PNG, JPEG, WebP" },
    });
  if (file.size > MAX_BYTES)
    throw new BadRequestError("upload.too_large", {
      message: "Logo file is too large (max 5 MB)",
      params: { max_mb: 5 },
    });
  if (file.size === 0) throw new BadRequestError("upload.empty", { message: "Empty file" });
  return file;
}

async function folderId(db: Conn): Promise<string> {
  const existing = await folderByName(db, "custom_logos");
  if (existing) return existing;
  const id = newId();
  await insertFolder(db, id, "custom_logos");
  return id;
}

/** Directus's title for an uploaded file: the name without extension, words capitalised. */
function titleOf(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/** Stores the upload and returns its file id. The object is written before the row. */
export async function saveLogo(
  store: LogoStore | undefined,
  db: Conn,
  now: Date,
  file: File,
): Promise<string> {
  if (!store)
    throw new UnavailableError("internal.unavailable", {
      message: "Logo uploads are not configured",
    });
  const id = newId();
  const type = file.type || "image/png";
  const diskName = `${id}${EXT[type] ?? ""}`;
  await store.objects.put(diskName, new Uint8Array(await file.arrayBuffer()), type);
  await insertFile(db, {
    id,
    storage: store.location,
    filename_disk: diskName,
    filename_download: file.name || diskName,
    title: titleOf(file.name || diskName),
    type,
    folder: await folderId(db),
    filesize: file.size,
    created_on: iso(now),
    modified_on: iso(now),
    uploaded_on: iso(now),
  });
  return id;
}

/** Best effort: a leftover object costs storage, a failed request would cost the user. */
export async function deleteLogo(store: LogoStore | undefined, db: Conn, fileId: string) {
  if (!isUuid(fileId)) return;
  const row = await fileDiskName(db, fileId);
  if (!row) return;
  await deleteFile(db, fileId);
  if (store && row.disk) await store.objects.delete(row.disk).catch(() => undefined);
}
