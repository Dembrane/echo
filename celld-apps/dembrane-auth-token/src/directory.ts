import { DurableObject } from "cloudflare:workers";
import type { DirectoryUser } from "./directus";

export type Snapshot = { users: DirectoryUser[]; updatedAt: number | null };
export type Settings = { usersCanSeeEachOther: boolean };

// One instance for the whole demo (the Worker always asks for it by the same
// name), holding state that belongs to no single user: a snapshot of the
// Directus users, which an admin refreshes, and the admin's settings.
// Unlike KV, a Durable Object is strongly consistent, which matters because the
// settings decide who may increment: a toggle takes effect on the next request.
// Like User, it does no auth itself; the Worker checks who may call what.
export class Directory extends DurableObject<Env> {
  getSnapshot(): Snapshot {
    return this.ctx.storage.kv.get<Snapshot>("snapshot") ?? { users: [], updatedAt: null };
  }

  setUsers(users: DirectoryUser[]): Snapshot {
    const snapshot = { users, updatedAt: Date.now() };
    this.ctx.storage.kv.put("snapshot", snapshot);
    return snapshot;
  }

  getSettings(): Settings {
    return this.ctx.storage.kv.get<Settings>("settings") ?? { usersCanSeeEachOther: false };
  }

  setSettings(settings: Settings): Settings {
    this.ctx.storage.kv.put("settings", settings);
    return settings;
  }
}
