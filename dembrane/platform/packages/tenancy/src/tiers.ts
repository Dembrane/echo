import { meetsTier, type Policy, TIER_REQUIRED, TIERS, type Tier } from "@dembrane/access";
import { pyRound } from "./numbers";

/**
 * The tier by capacity and price matrix, as the old API serves it. Paid tiers bill
 * per seat with unlimited hours; only free keeps a one hour cap. When pricing changes, this
 * is the one place to edit.
 */

/** Monthly billing costs this much more than the annual per-seat anchor. */
export const MONTHLY_BILLING_PREMIUM_PCT = 15;

export interface TierCapacity {
  readonly tier: Tier;
  readonly tagline: string;
  /** Per-seat annual-billing rate in EUR per month; null for free. */
  readonly priceEurMonthly: number | null;
  readonly includedSeats: number | null;
  readonly includedHours: number | null;
  /** Kept for the response shape; no tier blocks on hours any more. */
  readonly hardBlockOnHours: boolean;
  readonly trainingIncluded: string;
  readonly duration: string;
  readonly billingPeriodApplicable: boolean;
}

export const TIER_CAPACITIES: Readonly<Record<Tier, TierCapacity>> = {
  free: {
    tier: "free",
    tagline: "get started.",
    priceEurMonthly: null,
    includedSeats: null,
    includedHours: 1,
    hardBlockOnHours: false,
    trainingIncluded: "Sold separately",
    duration: "—",
    billingPeriodApplicable: false,
  },
  innovator: {
    tier: "innovator",
    tagline: "Bring your own LLM",
    priceEurMonthly: 20,
    includedSeats: null,
    includedHours: null,
    hardBlockOnHours: false,
    trainingIncluded: "Sold separately",
    duration: "ongoing",
    billingPeriodApplicable: true,
  },
  changemaker: {
    tier: "changemaker",
    tagline: "EU hosted LLMs included",
    priceEurMonthly: 75,
    includedSeats: null,
    includedHours: null,
    hardBlockOnHours: false,
    trainingIncluded: "Sold separately",
    duration: "ongoing",
    billingPeriodApplicable: true,
  },
  guardian: {
    tier: "guardian",
    tagline: "Cloud Act Safe",
    priceEurMonthly: 150,
    includedSeats: null,
    includedHours: null,
    hardBlockOnHours: false,
    trainingIncluded: "Sold separately",
    duration: "ongoing",
    billingPeriodApplicable: true,
  },
};

/** Unknown tiers (legacy pilot, pioneer, a missing account) read as unlimited, never as a crash. */
export function capacityOf(tier: string | null | undefined): TierCapacity | null {
  return tier && (TIERS as readonly string[]).includes(tier) ? TIER_CAPACITIES[tier as Tier] : null;
}

export function nextTier(tier: string | null | undefined): Tier | null {
  const i = (TIERS as readonly string[]).indexOf(tier ?? "");
  return i >= 0 && i + 1 < TIERS.length ? (TIERS[i + 1] as Tier) : null;
}

export interface TierPricing {
  annual_billing: { per_month_eur: number; total_per_year_eur: number };
  monthly_billing: { per_month_eur: number };
}

export function tierPricing(tier: string): TierPricing | null {
  const cap = capacityOf(tier);
  if (!cap?.billingPeriodApplicable || cap.priceEurMonthly === null) return null;
  const annual = cap.priceEurMonthly;
  return {
    annual_billing: { per_month_eur: annual, total_per_year_eur: annual * 12 },
    // Half to even, as the old API rounded: 150 * 1.15 = 172.5 shows as 172.
    monthly_billing: { per_month_eur: pyRound(annual * (1 + MONTHLY_BILLING_PREMIUM_PCT / 100)) },
  };
}

/** Paid tiers are never hour capped. */
export function allowsOverage(tier: string | null | undefined): boolean {
  return tier === "innovator" || tier === "changemaker" || tier === "guardian";
}

export function usageGates(tier: string, hoursLifetime: number) {
  const cap = capacityOf(tier);
  if (allowsOverage(tier) || !cap || cap.includedHours === null)
    return { over_cap_active: false, uploads_locked: false };
  const over = hoursLifetime >= cap.includedHours;
  return { over_cap_active: over, uploads_locked: over };
}

/**
 * What a downgrade does to each tier-gated feature, in the order the confirmation dialog
 * lists them. `revert` clears state; `freeze` keeps what exists and blocks new use. API
 * access is not listed: the policy was never enforced and is gone (spec L-26, CTO Q10).
 */
export const DOWNGRADE_EFFECTS: readonly {
  policy: Policy;
  effect: "revert" | "freeze";
  human: string;
}[] = [
  {
    policy: "workspace:export",
    effect: "freeze",
    human: "Freeze data export (existing files stay; new exports blocked)",
  },
  {
    policy: "project:share",
    effect: "freeze",
    human: "Freeze private project sharing (existing shares stay; no new shares)",
  },
  {
    policy: "workspace:whitelabel",
    effect: "revert",
    human: "Remove your custom logo (revert to dembrane logo)",
  },
  {
    policy: "workspace:webhooks",
    effect: "freeze",
    human: "Freeze webhooks (existing webhooks keep firing; no new configs)",
  },
  {
    policy: "workspace:set_private",
    effect: "freeze",
    human: "Freeze ability to make new private workspaces",
  },
  {
    policy: "project:set_private",
    effect: "freeze",
    human: "Freeze ability to make new private projects",
  },
];

/** Tier order for direction checks; the legacy names staff can still set sit below free. */
export const TIER_ORDER = TIERS;

/**
 * The features a move from one tier to another takes away. A tier the matrix does not know
 * (legacy pilot, pioneer) meets no gate, as the old API's meets_tier answered.
 */
export function downgradeEffects(fromTier: string, toTier: string) {
  const meets = (t: string, required: Tier) => t !== "" && meetsTier(t, required);
  const toIdx = (TIERS as readonly string[]).indexOf(toTier);
  const fromIdx = (TIERS as readonly string[]).indexOf(fromTier);
  if (toIdx >= 0 && fromIdx >= 0 && toIdx >= fromIdx) return [];
  return DOWNGRADE_EFFECTS.filter(({ policy }) => {
    const required = TIER_REQUIRED[policy];
    return required !== undefined && meets(fromTier, required) && !meets(toTier, required);
  }).map((e) => ({ policy: e.policy, effect: e.effect, human: e.human }));
}
