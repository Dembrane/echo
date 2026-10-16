import { Agent } from "agents";
import { type Config, type ConfigView, FIELD_KEYS } from "../shared/fields";
import { type ApiProject, type ApiResult, fetchProject, patchProject } from "./api";

type FieldRow = {
  key: string;
  value: string | null;
  server_value: string | null;
  dirty: number;
  author: string | null;
  updated_at: number;
};

/** A call's answer: the mirror, or the API's refusal passed through. */
export type ConfigResult =
  | { ok: true; view: ConfigView }
  | { ok: false; status: number; body: unknown };

/**
 * One project's settings, mirrored from the dembrane API. The page reads and
 * writes this mirror, and it syncs to the API.
 *
 * It holds no credentials. Each call brings the caller's session cookie, and
 * each one asks the API first, so the API's access rules still decide who
 * sees and changes what. A change the API couldn't take yet (it was down)
 * stays pending, and is sent again only with the session of whoever made it.
 */
export class ProjectConfig extends Agent<Env> {
  async onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS fields (
      key TEXT PRIMARY KEY,
      value TEXT,
      server_value TEXT,
      dirty INTEGER NOT NULL DEFAULT 0,
      author TEXT,
      updated_at INTEGER NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`;
  }

  /** The settings, fresh from the API, with any of the caller's pending changes sent again. */
  async load(cookie: string, userId: string): Promise<ConfigResult> {
    const pulled = await this.pull(cookie);
    if (!pulled.ok) return pulled;
    const rejected = await this.sync(cookie, userId);
    return { ok: true, view: this.view(rejected) };
  }

  /** Saves the changes here first, then sends them to the API. */
  async update(cookie: string, userId: string, fields: Config): Promise<ConfigResult> {
    // Asks the API before keeping anything, so someone who can't see the
    // project can't leave changes behind for someone else's sync.
    const pulled = await this.pull(cookie);
    if (!pulled.ok) return pulled;

    const now = Date.now();
    for (const [key, value] of Object.entries(fields)) {
      if (!FIELD_KEYS.has(key)) continue;
      this.sql`INSERT INTO fields (key, value, dirty, author, updated_at)
        VALUES (${key}, ${JSON.stringify(value)}, 1, ${userId}, ${now})
        ON CONFLICT (key) DO UPDATE SET
          value = excluded.value, dirty = 1, author = excluded.author, updated_at = excluded.updated_at`;
    }
    const rejected = await this.sync(cookie, userId);
    return { ok: true, view: this.view(rejected) };
  }

  /** Takes the API's values. Fields with a pending change keep it. */
  private async pull(cookie: string): Promise<ApiResult<ApiProject>> {
    const res = await fetchProject(this.env, cookie, this.name);
    if (!res.ok) return res;
    this.take(res.body);
    this.setMeta("role", res.body._role ?? null);
    return res;
  }

  private take(project: Config) {
    const now = Date.now();
    for (const [key, value] of Object.entries(project)) {
      if (!FIELD_KEYS.has(key)) continue;
      const json = JSON.stringify(value);
      this.sql`INSERT INTO fields (key, value, server_value, updated_at)
        VALUES (${key}, ${json}, ${json}, ${now})
        ON CONFLICT (key) DO UPDATE SET
          server_value = excluded.server_value,
          value = CASE WHEN fields.dirty = 1 THEN fields.value ELSE excluded.value END`;
    }
    this.setMeta("last_synced_at", String(now));
  }

  /**
   * Sends the caller's pending changes in one PATCH. Rows changed again while
   * it's in flight stay pending for the next sync.
   */
  private async sync(cookie: string, userId: string): Promise<ConfigView["rejected"]> {
    const rows = this.sql<FieldRow>`SELECT * FROM fields WHERE dirty = 1 AND author = ${userId}`;
    if (!rows.length) return undefined;

    const body: Config = {};
    for (const r of rows) body[r.key] = r.value === null ? null : JSON.parse(r.value);
    const res = await patchProject(this.env, cookie, this.name, body);

    if (res.ok) {
      for (const r of rows) {
        this.sql`UPDATE fields SET dirty = 0, author = NULL, server_value = ${r.value}
          WHERE key = ${r.key} AND updated_at = ${r.updated_at}`;
      }
      if (res.body && typeof res.body === "object") this.take(res.body);
      return undefined;
    }
    if (res.status >= 500) {
      console.warn(`project ${this.name}: sync failed with ${res.status}; changes stay pending`);
      return undefined;
    }
    // The API refused them, as invalid or not allowed: back to its values.
    for (const r of rows) {
      this.sql`UPDATE fields SET value = server_value, dirty = 0, author = NULL
        WHERE key = ${r.key} AND updated_at = ${r.updated_at}`;
    }
    return { fields: rows.map((r) => r.key), error: { status: res.status, body: res.body } };
  }

  private view(rejected: ConfigView["rejected"]): ConfigView {
    const rows = this.sql<FieldRow>`SELECT * FROM fields`;
    const config: Config = {};
    for (const r of rows) config[r.key] = r.value === null ? null : JSON.parse(r.value);
    const synced = this.getMeta("last_synced_at");
    return {
      config,
      pending: rows.filter((r) => r.dirty).map((r) => r.key),
      lastSyncedAt: synced ? Number(synced) : null,
      role: this.getMeta("role"),
      ...(rejected && { rejected }),
    };
  }

  private getMeta(key: string): string | null {
    return (
      this.sql<{ value: string | null }>`SELECT value FROM meta WHERE key = ${key}`[0]?.value ??
      null
    );
  }

  private setMeta(key: string, value: string | null) {
    this.sql`INSERT INTO meta (key, value) VALUES (${key}, ${value})
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`;
  }
}
