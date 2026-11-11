import { aiBudgetForProject } from "@dembrane/allowance";
import { StatusError } from "@dembrane/core";
import type { Db } from "@dembrane/db";

/** Verify and Explore at a used-up AI budget: a plain refusal that names no plan. */
export async function requirePortalAi(db: Db, projectId: string, now: Date): Promise<void> {
  if ((await aiBudgetForProject(db, projectId, now))?.exhausted)
    throw new StatusError(403, "portal.ai_unavailable");
}
