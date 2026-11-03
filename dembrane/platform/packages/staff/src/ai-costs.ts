import { AI_SPEND_KEY, isFreeTier, monthStart, periodStart } from "@dembrane/allowance";
import type { Db } from "@dembrane/db";
import { sql } from "drizzle-orm";

export interface AiCostAccount {
  billing_account_id: string;
  name: string;
  tier: string | null;
  cost_micro_eur: number;
  budget_micro_eur: number | null;
  percent_used: number | null;
  unlimited: boolean;
  override_until: string | null;
  by_feature: { operation: string; cost_micro_eur: number }[];
  by_model: { model: string; cost_micro_eur: number }[];
}

export interface AiCostView {
  period_start: string;
  accounts: AiCostAccount[];
  unattributed_micro_eur: number;
  by_provider: { provider: string; cost_micro_eur: number }[];
}

type SpendRow = {
  billing_account_id: string | null;
  payer: string;
  operation: string;
  model: string;
  provider: string;
  cost: string;
};

type AccountInfo = {
  id: string;
  name: string;
  tier: string | null;
  downgraded_at: string | null;
  amount: string | null;
  unlimited: boolean;
  until: string | null;
};

type Totals = { cost: number; features: Map<string, number>; models: Map<string, number> };

const MS = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

// Rolled up days come from ai_spend_daily, whose provider is the model's only priced provider.
function spendRows(db: Db, from: Date, to: Date, useRollup: boolean) {
  const fromDay = from.toISOString().slice(0, 10);
  const toDay = to.toISOString().slice(0, 10);
  return db.execute<SpendRow>(sql`
    with rolled as (
      select distinct day from ai_spend_daily
      where ${useRollup} and day >= ${fromDay}::date and day < ${toDay}::date
    ), spend as (
      select s.billing_account_id, s.payer, s.operation, s.model,
        coalesce((select min(p.provider) from ai_price p where p.model = s.model
          having count(distinct p.provider) = 1), 'unknown') as provider,
        s.cost_micro_eur as cost
      from ai_spend_daily s where s.day in (select day from rolled)
      union all
      select m.billing_account_id, m.payer, coalesce(m.operation, ''), m.model,
        coalesce(m.provider, 'unknown'), coalesce(m.cost_micro_eur, 0)
      from model_call m
      where m.started_at >= ${from.toISOString()}::timestamptz
        and m.started_at < ${to.toISOString()}::timestamptz
        and (m.started_at at time zone 'UTC')::date not in (select day from rolled)
    )
    select billing_account_id, payer, operation, model, provider, sum(cost)::text as cost
    from spend group by billing_account_id, payer, operation, model, provider`);
}

function accountInfo(db: Db, ids: string[]) {
  if (!ids.length) return Promise.resolve([] as AccountInfo[]);
  return db.execute<AccountInfo>(sql`
    select b.id, coalesce(o.name, w.name, nullif(b.label, ''), '') as name, b.tier,
      to_char(b.downgraded_at at time zone 'UTC', ${sql.raw(MS)}) as downgraded_at,
      b.ai_budget_micro_eur::text as amount, b.ai_budget_unlimited as unlimited,
      to_char(b.ai_budget_until at time zone 'UTC', ${sql.raw(MS)}) as until
    from billing_account b
    left join org o on o.id = b.org_id
    left join workspace w on w.id = b.workspace_id
    where b.id in (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`);
}

async function freeSpend(db: Db, ids: string[], from: Date, to: Date) {
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const rows = await db.execute<{ id: string; period: string; amount: string }>(sql`
    select billing_account_id as id,
      to_char(period_start at time zone 'UTC', ${sql.raw(MS)}) as period, amount::text as amount
    from free_usage
    where key = ${AI_SPEND_KEY} and period_start >= ${from.toISOString()}::timestamptz
      and period_start < ${to.toISOString()}::timestamptz
      and billing_account_id in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`);
  for (const r of rows) out.set(`${r.id} ${r.period}`, Number(r.amount));
  return out;
}

const desc = <T extends { cost_micro_eur: number }>(
  m: Map<string, number>,
  wrap: (k: string, c: number) => T,
) => [...m].map(([k, c]) => wrap(k, c)).sort((a, b) => b.cost_micro_eur - a.cost_micro_eur);

function bump(m: Map<string, number>, key: string, cost: number) {
  m.set(key, (m.get(key) ?? 0) + cost);
}

/** AI cost for this month (offset 0) or last month (offset 1); budgets read the free period. */
export async function aiCosts(
  db: Db,
  now: Date,
  monthOffset: number,
  defaultBudget: number,
): Promise<AiCostView> {
  const thisMonth = monthStart(now);
  const from = new Date(
    Date.UTC(thisMonth.getUTCFullYear(), thisMonth.getUTCMonth() - monthOffset, 1),
  );
  const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
  // The moment the month is judged at: now, or the last instant of a past month.
  const at = to > now ? now : new Date(to.getTime() - 1);

  const rows = await spendRows(db, from, to, monthOffset > 0);
  let unattributed = 0;
  const providers = new Map<string, number>();
  const per = new Map<string, Totals>();
  for (const r of rows) {
    const cost = Number(r.cost);
    bump(providers, r.provider, cost);
    if (r.payer === "unattributed") unattributed += cost;
    if (!r.billing_account_id) continue;
    const a: Totals = per.get(r.billing_account_id) ?? {
      cost: 0,
      features: new Map(),
      models: new Map(),
    };
    a.cost += cost;
    bump(a.features, r.operation, cost);
    bump(a.models, r.model, cost);
    per.set(r.billing_account_id, a);
  }

  const ids = [...per.keys()];
  const [infos, spent] = await Promise.all([accountInfo(db, ids), freeSpend(db, ids, from, to)]);
  const accounts: AiCostAccount[] = infos.map((info) => {
    const a = per.get(info.id) as Totals;
    const active = info.until === null || new Date(info.until) > at;
    const unlimited = active && info.unlimited;
    // A free account downgraded after the month was paid during it.
    const free =
      isFreeTier(info.tier) && !(info.downgraded_at && new Date(info.downgraded_at) >= to);
    let budget: number | null = null;
    let percent: number | null = null;
    if (free && !unlimited) {
      budget = active && info.amount !== null ? Number(info.amount) : defaultBudget;
      const start = periodStart(at, info.tier, info.downgraded_at).toISOString();
      const used = spent.get(`${info.id} ${start}`) ?? 0;
      percent = budget <= 0 ? 100 : Math.floor((used * 100) / budget);
    }
    const hasOverride = info.unlimited || info.amount !== null;
    return {
      billing_account_id: info.id,
      name: info.name,
      tier: info.tier,
      cost_micro_eur: a.cost,
      budget_micro_eur: budget,
      percent_used: percent,
      unlimited,
      override_until: hasOverride ? info.until : null,
      by_feature: desc(a.features, (operation, c) => ({ operation, cost_micro_eur: c })),
      by_model: desc(a.models, (model, c) => ({ model, cost_micro_eur: c })),
    };
  });
  accounts.sort(
    (x, y) =>
      y.cost_micro_eur - x.cost_micro_eur ||
      x.billing_account_id.localeCompare(y.billing_account_id),
  );
  return {
    period_start: from.toISOString(),
    accounts,
    unattributed_micro_eur: unattributed,
    by_provider: desc(providers, (provider, c) => ({ provider, cost_micro_eur: c })),
  };
}
