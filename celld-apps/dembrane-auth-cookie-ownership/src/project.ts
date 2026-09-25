import { DurableObject } from "cloudflare:workers";

// One instance per dembrane project (the Worker picks it with
// getByName(projectId)), holding its counter.
// Like User, it does no auth itself: the Worker has already checked the
// caller's role in the project's organisation (see ownership.ts).
export class Project extends DurableObject<Env> {
  getCount(): number {
    return this.ctx.storage.kv.get<number>("count") ?? 0;
  }

  increment(): number {
    const count = this.getCount() + 1;
    this.ctx.storage.kv.put("count", count);
    return count;
  }
}
