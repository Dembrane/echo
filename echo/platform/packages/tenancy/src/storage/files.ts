import { schema } from "@echo/db";
import { asc, eq } from "drizzle-orm";
import type { Conn } from "../db";

const { directus_files, directus_folders } = schema;

export async function folderByName(db: Conn, name: string) {
  const [row] = await db
    .select({ id: directus_folders.id })
    .from(directus_folders)
    .where(eq(directus_folders.name, name))
    .orderBy(asc(directus_folders.id))
    .limit(1);
  return row?.id ?? null;
}

export async function insertFolder(db: Conn, id: string, name: string) {
  await db.insert(directus_folders).values({ id, name });
}

export async function insertFile(db: Conn, row: typeof directus_files.$inferInsert) {
  await db.insert(directus_files).values(row);
}

export async function fileDiskName(db: Conn, id: string) {
  const [row] = await db
    .select({ disk: directus_files.filename_disk })
    .from(directus_files)
    .where(eq(directus_files.id, id))
    .limit(1);
  return row ? { disk: row.disk } : null;
}

export async function deleteFile(db: Conn, id: string) {
  await db.delete(directus_files).where(eq(directus_files.id, id));
}
