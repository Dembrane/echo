import {
  aiBudgetForProject,
  allowanceForCountedProject,
  freeLimits,
  requireAiBudget,
} from "@dembrane/allowance";
import type { Db } from "@dembrane/db";
import type { Json } from "./py";
import { MIN_CADENCE_MINUTES } from "./settings";

export interface PopcornAllowance {
  /** False when the free account's AI budget is used up. */
  admit(projectId: string, now: Date): Promise<boolean>;
  /** Null when there is no budget (paid, unknown or a sample). */
  status(projectId: string, now: Date): Promise<{ exhausted: boolean } | null>;
  requireRoom(projectId: string, now: Date): Promise<void>;
  cadenceFloorMinutes(projectId: string, now: Date): Promise<number>;
}

// Free popcorn runs while the account's AI budget lasts.
export function popcornAllowance(db: Db): PopcornAllowance {
  async function status(projectId: string, now: Date) {
    const b = await aiBudgetForProject(db, projectId, now);
    return b ? { exhausted: b.exhausted } : null;
  }

  return {
    async admit(projectId, now) {
      return !(await status(projectId, now))?.exhausted;
    },

    status,

    requireRoom: (projectId, now) => requireAiBudget(db, projectId, now),

    async cadenceFloorMinutes(projectId, now) {
      if (!(await allowanceForCountedProject(db, projectId, now))) return MIN_CADENCE_MINUTES;
      return (await freeLimits(db)).popcorn_cadence_minutes;
    },
  };
}

// Adds the host's AI budget status (null when there is none) to a payload.
export async function withAiBudget(
  db: Db,
  detail: Json,
  projectId: string,
  now: Date,
): Promise<Json> {
  detail.ai_budget = await popcornAllowance(db).status(projectId, now);
  return detail;
}
