import type { Db } from "@dembrane/db";
import { allowanceForWorkspace } from "./account";
import { aiBudgetFor } from "./budget";
import { usedThisPeriod } from "./ledger";
import { freeLimits } from "./limits";
import { nextReset } from "./period";
import { liveProjectCount } from "./projects";

export { accountWorkspaceIds } from "./projects";

export type Meter = { used: number; limit: number };

// Percent only: customers never see euro amounts.
export type AiMeter = { percent_used: number; exhausted: boolean; unlimited: boolean };

export interface AllowanceSnapshot {
  free: boolean;
  // Whose allowance this is: the organisation's shared one, or this workspace's own.
  scope: "organisation" | "workspace" | null;
  period_start: string | null;
  resets_at: string | null;
  audio_seconds: Meter | null;
  projects: Meter | null;
  ai: AiMeter | null;
}

const NOT_FREE: AllowanceSnapshot = Object.freeze({
  free: false,
  scope: null,
  period_start: null,
  resets_at: null,
  audio_seconds: null,
  projects: null,
  ai: null,
});

export async function allowanceSnapshot(
  db: Db,
  workspaceId: string,
  now: Date,
): Promise<AllowanceSnapshot> {
  const a = await allowanceForWorkspace(db, workspaceId, now);
  if (!a) return NOT_FREE;
  const usage = usedThisPeriod(db, a);
  const [limits, used, projects, budget] = await Promise.all([
    freeLimits(db),
    usage,
    liveProjectCount(db, a),
    aiBudgetFor(db, a, now, usage),
  ]);
  return {
    free: true,
    scope: a.orgId ? "organisation" : "workspace",
    period_start: a.periodStart.toISOString(),
    resets_at: nextReset(now).toISOString(),
    audio_seconds: { used: used.audio_seconds, limit: limits.audio_seconds_month },
    projects: { used: projects, limit: limits.projects },
    ai: {
      percent_used: budget.percentUsed,
      exhausted: budget.exhausted,
      unlimited: budget.limitMicroEur === null,
    },
  };
}
