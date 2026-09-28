import {
  applyDiscount,
  effectiveMembersFromRows,
  getCapacity,
  perIntervalAmount,
  pyIso,
  seatState,
  seatUserIds,
} from "@dembrane/billing";
import { directusTime, parseTime, pyRound } from "@dembrane/legacy-shape";
import type { StaffStorage } from "./storage";

/** Legacy per-tier sticker prices the staff forecast still shows as the base. */
export const TIER_BASE_PRICE_EUR: Readonly<Record<string, number>> = {
  pilot: 349.0,
  pioneer: 200.0,
  innovator: 500.0,
  changemaker: 1500.0,
  guardian: 5000.0,
};

/** First of (this month + offset) to the first of the next, as Python isoformat strings. */
export function monthWindow(now: Date, offset = 0): [string, string] {
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth() + 1 + offset;
  while (m < 1) {
    m += 12;
    y -= 1;
  }
  while (m > 12) {
    m -= 12;
    y += 1;
  }
  const iso = (yy: number, mm: number) =>
    `${String(yy).padStart(4, "0")}-${String(mm).padStart(2, "0")}-01T00:00:00+00:00`;
  return [iso(y, m), m === 12 ? iso(y + 1, 1) : iso(y, m + 1)];
}

export interface BillingContact {
  user_id: string | null;
  display_name: string | null;
  email: string | null;
}

export interface BillingRow {
  workspace_id: string;
  workspace_name: string;
  org_id: string;
  org_name: string;
  billing_account_id: string | null;
  account_scope: "organisation" | "workspace" | null;
  tier: string;
  is_partner_owned: boolean;
  org_is_partner: boolean;
  billed_to_team_id: string | null;
  billed_to_team_name: string | null;
  audio_hours: number;
  audio_hours_included: number | null;
  hours_pct: number | null;
  over_hours: number;
  hour_overage_eur: number;
  seat_count: number;
  seats_included: number | null;
  over_seats: number;
  seat_overage_eur: number;
  external_count: number;
  observer_count: number;
  base_price_eur: number | null;
  total_forecast_eur: number | null;
  pilot_hard_block: boolean;
  approaching_cap: boolean;
  at_cap: boolean;
  downgraded_at: string | null;
  downgraded_from_tier: string | null;
  is_active: boolean;
  workspace_admins: BillingContact[];
  tier_expires_at: string | null;
  type_discount: string | null;
  percent_discount: number | null;
  billing_period: string | null;
  payment_mode: string | null;
}

export interface AccountRow {
  billing_account_id: string;
  label: string;
  account_scope: "organisation" | "workspace" | null;
  org_id: string | null;
  org_name: string | null;
  tier: string;
  workspace_count: number;
  active_workspace_count: number;
  seat_count: number;
  external_count: number;
  observer_count: number;
  base_price_eur: number | null;
  total_forecast_eur: number;
  is_trial: boolean;
  is_managed: boolean;
  is_comped: boolean;
  is_active: boolean;
  tier_expires_at: string | null;
  type_discount: string | null;
  percent_discount: number | null;
  payment_mode: string | null;
  workspaces: BillingRow[];
}

export function isTrialAccount(p: {
  typeDiscount: string | null;
  paymentMode: string | null;
  tier: string | null;
  tierExpiresAt: string | null;
  now: Date;
}): boolean {
  if (p.typeDiscount === "trial") return true;
  const expiry = parseTime(p.tierExpiresAt);
  return Boolean(
    p.paymentMode === "none" && p.tier && p.tier !== "free" && expiry && expiry > p.now,
  );
}

/** Discounted monthly revenue of a paying account: the same math Mollie is charged with. */
export function accountMonthlyForecast(
  tier: string,
  seats: number,
  billingPeriod: string | null,
  percentDiscount: number | null,
): number {
  const period = billingPeriod || "annual";
  let amount: number;
  try {
    amount = perIntervalAmount(tier, Math.max(seats, 1), period).amount;
  } catch {
    return 0;
  }
  return applyDiscount(period === "annual" ? amount / 12 : amount, percentDiscount);
}

function stableSort<T>(xs: T[], key: (x: T) => number[]): T[] {
  return xs
    .map((x, i) => ({ x, i, k: key(x) }))
    .sort((a, b) => {
      for (let j = 0; j < a.k.length; j++) {
        const d = (a.k[j] ?? 0) - (b.k[j] ?? 0);
        if (d) return d;
      }
      return a.i - b.i;
    })
    .map((e) => e.x);
}

function aggregateAccounts(
  rows: BillingRow[],
  orgNames: Map<string, string>,
  labels: Map<string, string | null>,
  paymentModes: Map<string, string | null>,
  pooledSeats: Map<string, number>,
  now: Date,
): AccountRow[] {
  const by = new Map<string, BillingRow[]>();
  for (const r of rows) {
    if (!r.billing_account_id) continue;
    const list = by.get(r.billing_account_id) ?? [];
    list.push(r);
    by.set(r.billing_account_id, list);
  }
  const accounts: AccountRow[] = [];
  for (const [id, members] of by) {
    const first = members[0] as BillingRow;
    const tier = first.tier;
    const paymentMode = paymentModes.get(id) ?? null;
    const label =
      labels.get(id) ||
      (first.account_scope === "organisation" ? first.org_name : first.workspace_name);
    const base = TIER_BASE_PRICE_EUR[tier] ?? null;
    const isTrial = isTrialAccount({
      typeDiscount: first.type_discount,
      paymentMode,
      tier,
      tierExpiresAt: first.tier_expires_at,
      now,
    });
    const isManaged = paymentMode === "offline";
    const isComped =
      isTrial || (!["mollie", "offline"].includes(paymentMode ?? "") && base !== null);
    const activeCount = members.filter((m) => m.is_active).length;
    const billable =
      pooledSeats.get(id) ?? members.reduce((s, m) => s + m.seat_count + m.external_count, 0);
    const forecast = isComped
      ? 0
      : accountMonthlyForecast(tier, billable, first.billing_period, first.percent_discount);
    accounts.push({
      billing_account_id: id,
      label: label || "",
      account_scope: first.account_scope,
      org_id: first.org_id || null,
      org_name: orgNames.get(first.org_id || "") || first.org_name || null,
      tier,
      workspace_count: members.length,
      active_workspace_count: activeCount,
      seat_count: members.reduce((s, m) => s + m.seat_count, 0),
      external_count: members.reduce((s, m) => s + m.external_count, 0),
      observer_count: members.reduce((s, m) => s + m.observer_count, 0),
      base_price_eur: base,
      total_forecast_eur: pyRound(forecast, 2),
      is_trial: isTrial,
      is_managed: isManaged,
      is_comped: isComped,
      is_active: activeCount > 0,
      tier_expires_at: first.tier_expires_at,
      type_discount: first.type_discount,
      percent_discount: first.percent_discount,
      payment_mode: paymentMode,
      workspaces: members,
    });
  }
  return stableSort(accounts, (a) => [a.is_comped ? 1 : 0, -a.total_forecast_eur]);
}

/**
 * The monthly invoicing rollup across every live workspace (old admin.billing_rollup):
 * per-workspace usage and seats, then one row per billing account with pooled seats and
 * the discounted forecast. Trials and comped accounts forecast EUR 0.
 */
export async function billingRollup(s: StaffStorage, now: Date, monthOffset: number) {
  const [cycleStart, cycleEnd] = monthWindow(now, monthOffset);
  const workspaces = await s.rollupWorkspaces();
  const orgIds = workspaces.map((w) => w.org_id).filter(Boolean);
  const orgRows = await s.orgs(orgIds);
  const orgNames = new Map(orgRows.map((o) => [o.id, o.name ?? ""]));
  const orgPartner = new Map(orgRows.map((o) => [o.id, Boolean(o.is_partner)]));
  const wsIds = workspaces.map((w) => w.id);

  // A staff usage reset floors the cycle for that workspace.
  const startByWs = new Map<string, string>();
  for (const ws of workspaces) {
    const settings = (ws.settings ?? {}) as Record<string, unknown>;
    const reset = typeof settings.usage_reset_at === "string" ? settings.usage_reset_at : null;
    const r = parseTime(reset);
    const within = r && r >= (parseTime(cycleStart) as Date) && r < (parseTime(cycleEnd) as Date);
    startByWs.set(ws.id, within ? (reset as string) : cycleStart);
  }
  const [projects, memberships, orgMembers] = await Promise.all([
    s.liveProjects(wsIds),
    s.memberships(wsIds),
    s.orgMembershipsIn([...new Set(orgIds)], ["owner", "admin", "member"]),
  ]);
  const wsByProject = new Map<string, string>();
  for (const p of projects) if (p.workspace_id) wsByProject.set(p.id, p.workspace_id);
  const byStart = new Map<string, string[]>();
  for (const [pid, wsId] of wsByProject) {
    const start = startByWs.get(wsId) ?? cycleStart;
    byStart.set(start, [...(byStart.get(start) ?? []), pid]);
  }
  const secondsByWs = new Map<string, number>();
  for (const [start, pids] of byStart)
    for (const row of await s.secondsByProject(pids, start, cycleEnd)) {
      const wsId = wsByProject.get(row.project_id);
      if (!wsId) continue;
      secondsByWs.set(wsId, (secondsByWs.get(wsId) ?? 0) + Number(row.seconds ?? 0));
    }
  const hoursByWs = new Map([...secondsByWs].map(([k, v]) => [k, pyRound(v / 3600, 2)]));

  const directByWs = new Map<string, typeof memberships>();
  for (const m of memberships)
    directByWs.set(m.workspace_id, [...(directByWs.get(m.workspace_id) ?? []), m]);
  const orgRowsByOrg = new Map<string, typeof orgMembers>();
  for (const r of orgMembers)
    orgRowsByOrg.set(r.org_id, [...(orgRowsByOrg.get(r.org_id) ?? []), r]);

  const membersByWs = new Map<string, ReturnType<typeof effectiveMembersFromRows>>();
  const adminUidsByWs = new Map<string, string[]>();
  for (const ws of workspaces) {
    const direct = directByWs.get(ws.id) ?? [];
    membersByWs.set(ws.id, effectiveMembersFromRows(ws, direct, orgRowsByOrg.get(ws.org_id) ?? []));
    // Admin contacts: first three admin or owner rows, staff support included, as before.
    adminUidsByWs.set(
      ws.id,
      direct
        .filter((r) => r.role === "admin" || r.role === "owner")
        .slice(0, 3)
        .map((r) => r.user_id),
    );
  }

  let rows: BillingRow[] = [];
  let totalBase = 0;
  const labels = new Map<string, string | null>();
  const modes = new Map<string, string | null>();
  for (const ws of workspaces) {
    const tier = ws.tier ?? "pioneer";
    const cap = getCapacity(tier);
    const hours = hoursByWs.get(ws.id) ?? 0;
    const [, seatCount, externalCount, observerCount] = seatState(membersByWs.get(ws.id) ?? []);
    const includedHours = cap ? cap.includedHours : null;
    const includedSeats = cap ? cap.includedSeats : null;
    const overHours = includedHours !== null ? Math.max(0, hours - includedHours) : 0;
    const overSeats =
      includedSeats !== null ? Math.max(0, seatCount + externalCount - includedSeats) : 0;
    const base = TIER_BASE_PRICE_EUR[tier] ?? null;
    const hoursPct = includedHours ? pyRound(hours / includedHours, 3) : null;
    const atCap = includedHours !== null && hours >= includedHours;
    const approaching = !atCap && hoursPct !== null && hoursPct >= 0.8;
    const billedTo = ws.billed_to_team_id || ws.org_id;
    const scope = ws.account_id ? (ws.account_org_id ? "organisation" : "workspace") : null;
    rows.push({
      workspace_id: ws.id,
      workspace_name: ws.name ?? "",
      org_id: ws.org_id ?? "",
      org_name: orgNames.get(ws.org_id) || "",
      billing_account_id: ws.account_id,
      account_scope: scope,
      tier,
      is_partner_owned: ws.billed_to_team_id !== null && ws.billed_to_team_id !== ws.org_id,
      org_is_partner: orgPartner.get(ws.org_id) ?? false,
      billed_to_team_id: billedTo,
      billed_to_team_name: billedTo ? (orgNames.get(billedTo) ?? null) : null,
      audio_hours: hours,
      audio_hours_included: includedHours,
      hours_pct: hoursPct,
      over_hours: pyRound(overHours, 2),
      hour_overage_eur: 0,
      seat_count: seatCount,
      seats_included: includedSeats,
      over_seats: overSeats,
      seat_overage_eur: 0,
      external_count: externalCount,
      observer_count: observerCount,
      base_price_eur: base,
      total_forecast_eur: base !== null ? pyRound(base, 2) : null,
      // The pilot hard block is dead (no tier blocks on hours) and always false.
      pilot_hard_block: false,
      approaching_cap: approaching,
      at_cap: atCap,
      downgraded_at: directusTime(ws.downgraded_at),
      downgraded_from_tier: ws.downgraded_from_tier,
      is_active: hours > 0 || seatCount > 0 || externalCount > 0,
      workspace_admins: [],
      tier_expires_at: directusTime(ws.tier_expires_at),
      type_discount: ws.type_discount,
      percent_discount: ws.percent_discount,
      billing_period: ws.billing_period,
      payment_mode: ws.payment_mode,
    });
    if (ws.account_id) {
      labels.set(ws.account_id, ws.label);
      modes.set(ws.account_id, ws.payment_mode);
    }
    if (base !== null) totalBase += base;
  }

  const adminUsers = await s.appUsers([...new Set([...adminUidsByWs.values()].flat())]);
  const userById = new Map(adminUsers.map((u) => [u.id, u]));
  for (const r of rows)
    r.workspace_admins = (adminUidsByWs.get(r.workspace_id) ?? [])
      .filter((uid) => userById.has(uid))
      .map((uid) => ({
        user_id: uid,
        display_name: userById.get(uid)?.display_name ?? null,
        email: userById.get(uid)?.email ?? null,
      }));

  const risk = (r: BillingRow) =>
    r.pilot_hard_block ? 0 : r.at_cap ? 1 : r.approaching_cap ? 2 : 3;
  rows = stableSort(rows, (r) => [risk(r), -(r.total_forecast_eur ?? 0)]);

  const wsIdsByAccount = new Map<string, string[]>();
  for (const ws of workspaces)
    if (ws.account_id)
      wsIdsByAccount.set(ws.account_id, [...(wsIdsByAccount.get(ws.account_id) ?? []), ws.id]);
  const pooled = new Map<string, number>();
  for (const [acc, ids] of wsIdsByAccount) {
    const all = new Set<string>();
    for (const id of ids) for (const u of seatUserIds(membersByWs.get(id) ?? [])) all.add(u);
    pooled.set(acc, all.size);
  }
  const accounts = aggregateAccounts(rows, orgNames, labels, modes, pooled, now);
  const totalForecast = accounts.reduce((s2, a) => s2 + a.total_forecast_eur, 0);
  const mrr = accounts
    .filter((a) => !a.is_comped && a.tier !== "pilot")
    .reduce((s2, a) => s2 + a.total_forecast_eur, 0);
  const since = pyIso(new Date(now.getTime() - 30 * 86_400_000));
  return {
    cycle_start: cycleStart,
    cycle_end_exclusive: cycleEnd,
    workspace_count: rows.length,
    active_workspace_count: rows.filter((r) => r.is_active).length,
    account_count: accounts.length,
    active_account_count: accounts.filter((a) => a.is_active).length,
    trial_account_count: accounts.filter((a) => a.is_trial).length,
    managed_account_count: accounts.filter((a) => a.is_managed).length,
    comped_account_count: accounts.filter((a) => a.is_comped).length,
    total_base_eur: pyRound(totalBase, 2),
    total_overage_eur: 0,
    total_forecast_eur: pyRound(totalForecast, 2),
    mrr_eur: pyRound(mrr, 2),
    logins_last_30d: await s.recentLoginCount(since),
    accounts,
    rows,
  };
}

const f1 = (x: number) => pyRound(x, 1).toFixed(1);

/** Workspaces needing a call this week: at cap, approaching it, or downgraded in the last 14 days. */
export async function atRisk(s: StaffStorage, now: Date) {
  const rollup = await billingRollup(s, now, 0);
  const out: Record<string, unknown>[] = [];
  for (const r of rollup.rows) {
    const base = {
      workspace_id: r.workspace_id,
      workspace_name: r.workspace_name,
      org_id: r.org_id,
      org_name: r.org_name,
      tier: r.tier,
    };
    if (r.at_cap) {
      out.push({
        ...base,
        reason: "at_cap",
        detail: `${f1(r.audio_hours)}h / ${r.audio_hours_included}h at cap`,
      });
      continue;
    }
    if (r.approaching_cap)
      out.push({
        ...base,
        reason: "approaching_cap",
        detail: `${f1(r.audio_hours)}h / ${r.audio_hours_included}h (${pyRound((r.hours_pct ?? 0) * 100, 0).toFixed(0)}%)`,
      });
    const down = parseTime(r.downgraded_at);
    if (down && Math.floor((now.getTime() - down.getTime()) / 86_400_000) <= 14)
      out.push({
        ...base,
        reason: "recently_downgraded",
        detail: `Downgraded ${down.toISOString().slice(0, 10)} from ${r.downgraded_from_tier}`,
      });
  }
  return out;
}
