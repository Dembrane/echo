import { type Db, schema } from "@dembrane/db";
import { and, eq, sql } from "drizzle-orm";
import type { AllowanceAccount } from "./account";

const { free_usage } = schema;

export const USAGE_KEYS = [
  "audio_seconds",
  "chats",
  "reports",
  "maps",
  "popcorn_sessions",
] as const;
export type UsageKey = (typeof USAGE_KEYS)[number];

export type Take = { ok: true; used: number } | { ok: false; used: number; limit: number };

function check(amount: number, what = "amount"): void {
  if (!Number.isSafeInteger(amount) || amount < 0)
    throw new Error(`allowance ${what} must be a non-negative integer, got ${amount}`);
}

const rowOf = (a: AllowanceAccount, key: UsageKey) =>
  and(
    eq(free_usage.billing_account_id, a.accountId),
    eq(free_usage.period_start, a.periodStart.toISOString()),
    eq(free_usage.key, key),
  );

async function current(tx: Db, a: AllowanceAccount, key: UsageKey): Promise<number> {
  const [row] = await tx
    .select({ amount: free_usage.amount })
    .from(free_usage)
    .where(rowOf(a, key));
  return row ? Number(row.amount) : 0;
}

async function upsert(tx: Db, a: AllowanceAccount, key: UsageKey, amount: number) {
  const [row] = await tx
    .insert(free_usage)
    .values({
      billing_account_id: a.accountId,
      period_start: a.periodStart.toISOString(),
      key,
      amount,
    })
    .onConflictDoUpdate({
      target: [free_usage.billing_account_id, free_usage.period_start, free_usage.key],
      set: { amount: sql`${free_usage.amount} + excluded.amount`, updated_at: sql`now()` },
    })
    .returning({ amount: free_usage.amount });
  return Number(row?.amount ?? 0);
}

// One transaction holding the account+period lock; re-entrant when db is already a transaction.
export function withAllowanceLock<T>(
  db: Db,
  a: AllowanceAccount,
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const lockKey = `free_usage:${a.accountId}:${a.periodStart.toISOString()}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
    // The transaction lacks Db's $client and batch, so it is not structurally a Db.
    return fn(tx as unknown as Db);
  });
}

// Refuses when used + amount would pass the limit, else adds.
export async function take(
  db: Db,
  a: AllowanceAccount,
  key: UsageKey,
  amount: number,
  limit: number,
): Promise<Take> {
  check(amount);
  check(limit, "limit");
  return withAllowanceLock(db, a, async (tx) => {
    const used = await current(tx, a, key);
    if (used + amount > limit) return { ok: false, used, limit };
    return { ok: true, used: await upsert(tx, a, key, amount) };
  });
}

// Adds regardless of the limit and returns the new total.
export async function add(
  db: Db,
  a: AllowanceAccount,
  key: UsageKey,
  amount: number,
): Promise<number> {
  check(amount);
  return withAllowanceLock(db, a, (tx) => upsert(tx, a, key, amount));
}

// Subtracts, never below zero.
export async function giveBack(
  db: Db,
  a: AllowanceAccount,
  key: UsageKey,
  amount: number,
): Promise<void> {
  check(amount);
  await withAllowanceLock(db, a, (tx) =>
    tx
      .update(free_usage)
      .set({ amount: sql`greatest(${free_usage.amount} - ${amount}, 0)`, updated_at: sql`now()` })
      .where(rowOf(a, key)),
  );
}

export async function usedThisPeriod(
  db: Db,
  a: AllowanceAccount,
): Promise<Readonly<Record<UsageKey, number>>> {
  const rows = await db
    .select({ key: free_usage.key, amount: free_usage.amount })
    .from(free_usage)
    .where(
      and(
        eq(free_usage.billing_account_id, a.accountId),
        eq(free_usage.period_start, a.periodStart.toISOString()),
      ),
    );
  const used = Object.fromEntries(USAGE_KEYS.map((k) => [k, 0])) as Record<UsageKey, number>;
  for (const r of rows)
    if ((USAGE_KEYS as readonly string[]).includes(r.key))
      used[r.key as UsageKey] = Number(r.amount);
  return used;
}
