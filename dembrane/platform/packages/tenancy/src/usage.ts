import type { Conn } from "./db";
import { pyRound } from "./numbers";
import {
  cardAggregates,
  countReports,
  countUsedChats,
  oldestLiveChat,
  oldestReport,
  workspaceProjects,
} from "./storage/usage";
import { capacityOf, nextTier, usageGates } from "./tiers";

/** First instant of the calendar month `offset` months before the one holding `now`, UTC. */
export function monthBounds(now: Date, offset = 0): [Date, Date] {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return [start, end];
}

/** Python's datetime.isoformat() on a UTC midnight: "2026-09-01T00:00:00+00:00". */
export function pyIso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

export interface CardUsage {
  audio_hours: number;
  conversation_count: number;
  audio_hours_this_month: number;
  conversations_this_month: number;
  hours_included: number | null;
  hours_pct: number | null;
  at_cap: boolean;
  approaching_cap: boolean;
  usage_gates: {
    over_cap_active: boolean;
    uploads_locked: boolean;
    upgrade_cta_tier: string | null;
  };
}

/**
 * Hours and conversation counts for a workspace card: all time and this month. Hours keep
 * soft-deleted conversations (deleting keeps billable time); counts leave them out.
 */
export async function cardUsage(db: Conn, workspaceId: string, now: Date): Promise<CardUsage> {
  const base: CardUsage = {
    audio_hours: 0,
    conversation_count: 0,
    audio_hours_this_month: 0,
    conversations_this_month: 0,
    hours_included: null,
    hours_pct: null,
    at_cap: false,
    approaching_cap: false,
    usage_gates: { over_cap_active: false, uploads_locked: false, upgrade_cta_tier: null },
  };
  const ids = (await workspaceProjects(db, workspaceId)).map((p) => p.id);
  if (!ids.length) return base;
  const agg = await cardAggregates(db, ids, pyIso(monthBounds(now)[0]));
  return {
    ...base,
    audio_hours: pyRound(agg.hoursSeconds / 3600, 1),
    conversation_count: agg.count,
    audio_hours_this_month: pyRound(agg.monthSeconds / 3600, 1),
    conversations_this_month: agg.monthCount,
  };
}

/** Adds the tier's cap signals so the card needs no tier lookup of its own. */
export function withCapSignals(usage: CardUsage, tier: string): CardUsage {
  const out = { ...usage };
  const cap = capacityOf(tier);
  if (cap && cap.includedHours !== null) {
    out.hours_included = cap.includedHours;
    const pct = cap.includedHours ? usage.audio_hours_this_month / cap.includedHours : 0;
    out.hours_pct = pyRound(pct, 3);
    if (pct >= 1) out.at_cap = true;
    else if (pct >= 0.8) out.approaching_cap = true;
  }
  out.usage_gates = { ...usageGates(tier, usage.audio_hours), upgrade_cta_tier: nextTier(tier) };
  return out;
}

export const FREE_TIER_MAX_CHATS = 1;
export const FREE_TIER_MAX_REPORTS = 1;
export const FREE_TIER_MAX_WORKSPACES = 1;

/** The free tier block the frontend gates on; counted live so a deleted chat frees its slot at once. */
export async function freeTierBlock(db: Conn, tier: string | null, projectIds: readonly string[]) {
  const active = tier === "free";
  const [chats, primaryChat, reports, primaryReport] = active
    ? await Promise.all([
        countUsedChats(db, projectIds),
        oldestLiveChat(db, projectIds),
        countReports(db, projectIds),
        oldestReport(db, projectIds),
      ])
    : [0, null, 0, null];
  return {
    active,
    chats_used: chats,
    chats_limit: FREE_TIER_MAX_CHATS,
    primary_chat_id: primaryChat,
    reports_used: reports,
    reports_limit: FREE_TIER_MAX_REPORTS,
    primary_report_id: primaryReport,
  };
}

/** The 402 body the frontend keys on to show the upgrade path. */
export function freeTierLimit(limit: "workspaces" | "chats" | "report") {
  return { error: "FREE_TIER_LIMIT", limit, upgrade_cta_tier: "changemaker" };
}
