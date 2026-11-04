import { type Db, schema } from "@dembrane/db";
import { eq, sql } from "drizzle-orm";
import {
  type AllowanceAccount,
  allowanceForCountedProject,
  allowanceForWorkspace,
} from "./account";
import { freeLimitError } from "./errors";
import { isFreeTier } from "./free";
import { AI_SPEND_KEY, type UsageKey, usedThisPeriod } from "./ledger";
import { freeLimits } from "./limits";
import { nextReset } from "./period";

export { AI_SPEND_KEY } from "./ledger";

export interface AiBudget {
  readonly accountId: string;
  /** Null: no limit (staff override). */
  readonly limitMicroEur: number | null;
  readonly spentMicroEur: number;
  /** False when staff turned the check off. */
  readonly enforced: boolean;
  readonly exhausted: boolean;
  /** 0..100, floored and capped; 0 when there is no limit. */
  readonly percentUsed: number;
  readonly resetsAt: Date;
}

const { billing_account } = schema;

type Usage = Readonly<Record<UsageKey, number>>;

// Reads only; no lock, since two calls at once may overshoot the limit. Pass `used` already read for a.
export async function aiBudgetFor(
  db: Db,
  a: AllowanceAccount,
  now: Date,
  used?: Usage | Promise<Usage>,
): Promise<AiBudget> {
  const until = billing_account.ai_budget_until;
  const [limits, rows, usage] = await Promise.all([
    freeLimits(db, () => now),
    db
      .select({
        amount: billing_account.ai_budget_micro_eur,
        unlimited: billing_account.ai_budget_unlimited,
        active: sql<boolean>`(${until} is null or ${until} > ${now.toISOString()}::timestamptz)`,
      })
      .from(billing_account)
      .where(eq(billing_account.id, a.accountId)),
    used ?? usedThisPeriod(db, a),
  ]);
  const override = rows[0]?.active ? rows[0] : null;
  const limit = override?.unlimited
    ? null
    : override?.amount != null
      ? Number(override.amount)
      : limits.ai_budget_micro_eur;
  const spent = usage[AI_SPEND_KEY];
  const enforced = limits.ai_budget_enforce !== 0;
  return {
    accountId: a.accountId,
    limitMicroEur: limit,
    spentMicroEur: spent,
    enforced,
    exhausted: enforced && limit !== null && spent >= limit,
    percentUsed: percentOf(spent, limit),
    resetsAt: nextReset(now),
  };
}

function percentOf(spent: number, limit: number | null): number {
  if (limit === null) return 0;
  if (limit <= 0) return 100;
  return Math.floor((Math.min(spent, limit) * 100) / limit);
}

// Null: paid, unknown or a sample project.
export async function aiBudgetForProject(
  db: Db,
  projectId: string,
  now: Date,
): Promise<AiBudget | null> {
  const a = await allowanceForCountedProject(db, projectId, now);
  return a ? aiBudgetFor(db, a, now) : null;
}

// Null: paid or unknown.
export async function aiBudgetForWorkspace(
  db: Db,
  workspaceId: string,
  now: Date,
): Promise<AiBudget | null> {
  const a = await allowanceForWorkspace(db, workspaceId, now);
  return a ? aiBudgetFor(db, a, now) : null;
}

function refuseWhenExhausted(b: AiBudget | null): void {
  if (!b?.exhausted || b.limitMicroEur === null) return;
  // Percent only: the 402 reaches the browser, and customers never see euros.
  throw freeLimitError("ai_budget", {
    percent: b.percentUsed,
    resets_at: b.resetsAt.toISOString(),
  });
}

/** Throws the 402 `ai_budget` when exhausted; a non-free `tier` Access already read skips the reads. */
export async function requireAiBudget(
  db: Db,
  projectId: string,
  now: Date,
  tier?: string | null,
): Promise<void> {
  if (tier && !isFreeTier(tier)) return;
  refuseWhenExhausted(await aiBudgetForProject(db, projectId, now));
}

/** Throws the 402 `ai_budget` when the account resolved by the caller is exhausted. */
export async function requireAccountBudget(db: Db, a: AllowanceAccount, now: Date): Promise<void> {
  refuseWhenExhausted(await aiBudgetFor(db, a, now));
}

/** Throws the 402 `ai_budget` when exhausted. */
export async function requireAiBudgetForWorkspace(
  db: Db,
  workspaceId: string,
  now: Date,
): Promise<void> {
  refuseWhenExhausted(await aiBudgetForWorkspace(db, workspaceId, now));
}
