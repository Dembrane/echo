import type { Db } from "@dembrane/db";
import type { Logger } from "@dembrane/observability";
import { type AllowanceAccount, allowanceForCountedProject } from "./account";
import { type FreeLimitName, freeLimitError } from "./errors";
import { giveBack, take, usedThisPeriod } from "./ledger";
import { freeLimits, type LimitKey } from "./limits";

// One unit per started generation: the ledger key, its monthly limit and its 402 name.
const UNITS = {
  maps: { limit: "maps_month", name: "map" },
  popcorn_analyses: { limit: "popcorn_analyses_month", name: "popcorn" },
} as const satisfies Record<string, { limit: LimitKey; name: FreeLimitName }>;

export type FreeUnit = keyof typeof UNITS;

// Takes one unit; throws the free limit error when the period's units are spent.
export async function takeFreeUnit(
  db: Db,
  a: AllowanceAccount,
  unit: FreeUnit,
  now: Date,
): Promise<void> {
  const { limit, name } = UNITS[unit];
  const limits = await freeLimits(db, () => now);
  const took = await take(db, a, unit, 1, limits[limit]);
  if (!took.ok) throw freeLimitError(name, { used: took.used, cap: took.limit });
}

// Up-front check only; the take is what counts.
export async function requireFreeUnitRoom(
  db: Db,
  projectId: string,
  unit: FreeUnit,
  now: Date,
): Promise<void> {
  const a = await allowanceForCountedProject(db, projectId, now);
  if (!a) return;
  const { limit, name } = UNITS[unit];
  const cap = (await freeLimits(db, () => now))[limit];
  const used = (await usedThisPeriod(db, a))[unit];
  if (used >= cap) throw freeLimitError(name, { used, cap });
}

/** Takes one unit for a counted project; the returned give-back runs at most once. Null when uncounted. */
export async function chargeFreeUnit(
  db: Db,
  projectId: string,
  unit: FreeUnit,
  now: Date,
  logger?: Logger,
): Promise<(() => Promise<void>) | null> {
  const a = await allowanceForCountedProject(db, projectId, now);
  if (!a) return null;
  await takeFreeUnit(db, a, unit, now);
  let given = false;
  return async () => {
    if (given) return;
    given = true;
    await giveBack(db, a, unit, 1).catch((err) =>
      logger?.error({ err, project_id: projectId, unit }, "free unit not given back"),
    );
  };
}
