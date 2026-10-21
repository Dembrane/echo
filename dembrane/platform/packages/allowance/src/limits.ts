import { type Db, schema } from "@dembrane/db";
import type { Logger } from "@dembrane/observability";
import { eq, sql } from "drizzle-orm";

export const LIMIT_KEYS = [
  "audio_seconds_month",
  "audio_seconds_conversation",
  "projects",
  "chats_month",
  "chat_turns_per_chat",
  "reports_month",
  "maps_month",
  "popcorn_analyses_month",
  "popcorn_cadence_minutes",
] as const;

export type LimitKey = (typeof LIMIT_KEYS)[number];
export type FreeLimits = Readonly<Record<LimitKey, number>>;

export const FREE_LIMIT_DEFAULTS: FreeLimits = Object.freeze({
  audio_seconds_month: 18000,
  audio_seconds_conversation: 3600,
  projects: 1,
  chats_month: 2,
  chat_turns_per_chat: 20,
  reports_month: 1,
  maps_month: 1,
  popcorn_analyses_month: 12,
  popcorn_cadence_minutes: 5,
});

const FREE = "free";
const TTL_MS = 60_000;

let cached: { limits: FreeLimits; at: number } | null = null;

function isLimitKey(key: string): key is LimitKey {
  return (LIMIT_KEYS as readonly string[]).includes(key);
}

function readFreeRows(db: Db) {
  return db
    .select({
      key: schema.tier_limit.key,
      value: schema.tier_limit.value,
      updated_at: schema.tier_limit.updated_at,
      updated_by: schema.tier_limit.updated_by,
    })
    .from(schema.tier_limit)
    .where(eq(schema.tier_limit.tier, FREE));
}

// Rows overlay the code defaults; a failed read serves the defaults uncached.
export async function freeLimits(
  db: Db,
  now: () => Date = () => new Date(),
  logger?: Logger,
): Promise<FreeLimits> {
  const t = now().getTime();
  if (cached && t - cached.at >= 0 && t - cached.at < TTL_MS) return cached.limits;
  try {
    const rows = await readFreeRows(db);
    const limits: Record<LimitKey, number> = { ...FREE_LIMIT_DEFAULTS };
    for (const row of rows) if (isLimitKey(row.key)) limits[row.key] = Number(row.value);
    cached = { limits: Object.freeze(limits), at: t };
    return cached.limits;
  } catch (err) {
    logger?.warn({ err }, "free limits unreadable, serving defaults");
    return FREE_LIMIT_DEFAULTS;
  }
}

export function invalidateFreeLimits(): void {
  cached = null;
}

export async function setFreeLimit(
  db: Db,
  key: LimitKey,
  value: number,
  by: string | null,
): Promise<void> {
  await db
    .insert(schema.tier_limit)
    .values({ tier: FREE, key, value, updated_by: by })
    .onConflictDoUpdate({
      target: [schema.tier_limit.tier, schema.tier_limit.key],
      set: { value, updated_at: sql`now()`, updated_by: by },
    });
  invalidateFreeLimits();
}

export async function freeLimitRows(db: Db): Promise<
  {
    key: LimitKey;
    value: number;
    default: number;
    updated_at: string | null;
    updated_by: string | null;
  }[]
> {
  const rows = await readFreeRows(db);
  return LIMIT_KEYS.map((key) => {
    const row = rows.find((r) => r.key === key);
    return {
      key,
      value: row ? Number(row.value) : FREE_LIMIT_DEFAULTS[key],
      default: FREE_LIMIT_DEFAULTS[key],
      updated_at: row?.updated_at ?? null,
      updated_by: row?.updated_by ?? null,
    };
  });
}
