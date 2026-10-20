import type { Db } from "@dembrane/db";
import { allowanceForWorkspace } from "./account";
import { usedThisPeriod } from "./ledger";
import { freeLimits, type LimitKey } from "./limits";
import { nextReset } from "./period";
import { liveProjectCount } from "./projects";

export { accountWorkspaceIds } from "./projects";

export type Meter = { used: number; limit: number };

export interface AllowanceSnapshot {
  free: boolean;
  period_start: string | null;
  resets_at: string | null;
  audio_seconds: Meter | null;
  chats: Meter | null;
  reports: Meter | null;
  maps: Meter | null;
  popcorn_sessions: Meter | null;
  projects: Meter | null;
}

const METERS = {
  audio_seconds: "audio_seconds_month",
  chats: "chats_month",
  reports: "reports_month",
  maps: "maps_month",
  popcorn_sessions: "popcorn_sessions_month",
} as const satisfies Record<string, LimitKey>;

const NOT_FREE: AllowanceSnapshot = Object.freeze({
  free: false,
  period_start: null,
  resets_at: null,
  audio_seconds: null,
  chats: null,
  reports: null,
  maps: null,
  popcorn_sessions: null,
  projects: null,
});

export async function allowanceSnapshot(
  db: Db,
  workspaceId: string,
  now: Date,
): Promise<AllowanceSnapshot> {
  const a = await allowanceForWorkspace(db, workspaceId, now);
  if (!a) return NOT_FREE;
  const [limits, used, projects] = await Promise.all([
    freeLimits(db),
    usedThisPeriod(db, a),
    liveProjectCount(db, a),
  ]);
  const meter = (k: keyof typeof METERS): Meter => ({ used: used[k], limit: limits[METERS[k]] });
  return {
    free: true,
    period_start: a.periodStart.toISOString(),
    resets_at: nextReset(now).toISOString(),
    audio_seconds: meter("audio_seconds"),
    chats: meter("chats"),
    reports: meter("reports"),
    maps: meter("maps"),
    popcorn_sessions: meter("popcorn_sessions"),
    projects: { used: projects, limit: limits.projects },
  };
}
