import { connect } from "./connection";

/**
 * PR previews share the preview Cloud SQL instance and its two logins; each preview gets
 * its own database named by the PR. Only names of this shape can be created or dropped,
 * so a mistyped variable can never drop the branch preview's `echo` database.
 */
export const PREVIEW_DATABASE = /^echo_pr_[0-9]+$/;

/** The URL with its database replaced by `name`; unchanged when no name is given. */
export function withDatabase(url: string, name?: string): string {
  if (!name) return url;
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

function assertPreview(name: string): void {
  if (!PREVIEW_DATABASE.test(name)) {
    throw new Error(`${name} is not a PR preview database (echo_pr_<number>)`);
  }
}

/** Creates the preview database if it is missing, connecting through the URL's own database. */
export async function ensurePreviewDatabase(url: string, name: string): Promise<boolean> {
  assertPreview(name);
  const sql = connect(url, { max: 1, onnotice: () => {} });
  try {
    const [row] = await sql`select 1 from pg_database where datname = ${name}`;
    if (row) return false;
    await sql.unsafe(`create database "${name}"`);
    return true;
  } finally {
    await sql.end();
  }
}

/** Drops a preview database and every connection still open on it. */
export async function dropPreviewDatabase(url: string, name: string): Promise<void> {
  assertPreview(name);
  const sql = connect(url, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`drop database if exists "${name}" with (force)`);
  } finally {
    await sql.end();
  }
}
