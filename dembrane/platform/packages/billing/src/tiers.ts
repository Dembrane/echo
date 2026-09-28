import { pyRound } from "@dembrane/legacy-shape";

/**
 * Per-tier price and the Free hour cap. The single source for every price the
 * product shows or charges. Prices are per seat per month in EUR on annual billing;
 * monthly billing adds MONTHLY_BILLING_PREMIUM_PCT.
 */
export const MONTHLY_BILLING_PREMIUM_PCT = 15;

export interface TierCapacity {
  readonly tier: string;
  readonly tagline: string;
  /** Per-seat annual-billing rate, EUR per seat per month. Null for Free. */
  readonly priceEurMonthly: number | null;
  readonly priceNote: string;
  /** Hard seat cap. Null everywhere: seats are metered, never walled. */
  readonly includedSeats: number | null;
  /** Free is capped at one recorded hour; paid tiers are unlimited under fair use. */
  readonly includedHours: number | null;
  readonly trainingIncluded: string;
  readonly duration: string;
  readonly billingPeriodApplicable: boolean;
}

export const TIER_CAPACITIES: Readonly<Record<string, TierCapacity>> = {
  free: {
    tier: "free",
    tagline: "get started.",
    priceEurMonthly: null,
    priceNote: "free",
    includedSeats: null,
    includedHours: 1,
    trainingIncluded: "Sold separately",
    duration: "—",
    billingPeriodApplicable: false,
  },
  innovator: {
    tier: "innovator",
    tagline: "Bring your own LLM",
    priceEurMonthly: 20,
    priceNote: "per seat / month",
    includedSeats: null,
    includedHours: null,
    trainingIncluded: "Sold separately",
    duration: "ongoing",
    billingPeriodApplicable: true,
  },
  changemaker: {
    tier: "changemaker",
    tagline: "EU hosted LLMs included",
    priceEurMonthly: 75,
    priceNote: "per seat / month",
    includedSeats: null,
    includedHours: null,
    trainingIncluded: "Sold separately",
    duration: "ongoing",
    billingPeriodApplicable: true,
  },
  guardian: {
    tier: "guardian",
    tagline: "Cloud Act Safe",
    priceEurMonthly: 150,
    priceNote: "per seat / month",
    includedSeats: null,
    includedHours: null,
    trainingIncluded: "Sold separately",
    duration: "ongoing",
    billingPeriodApplicable: true,
  },
};

/** Tiers customers can buy themselves today; the others are shown as coming soon. */
export const PURCHASABLE_TIERS: ReadonlySet<string> = new Set(["changemaker"]);

export const PAYABLE_TIERS = ["innovator", "changemaker", "guardian"] as const;

export function getCapacity(tier: string | null | undefined): TierCapacity | null {
  return (tier && Object.hasOwn(TIER_CAPACITIES, tier) ? TIER_CAPACITIES[tier] : null) ?? null;
}

/** Monthly-cadence per-seat price: the annual rate plus the premium, to whole euros (half to even). */
export function computeMonthlyBillingPrice(annualPerMonth: number): number {
  return pyRound(annualPerMonth * (1 + MONTHLY_BILLING_PREMIUM_PCT / 100));
}

export class BillingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingError";
  }
}

/**
 * The subscription charge and its Mollie interval. Annual bills twelve months of the
 * annual rate once a year; monthly bills the surcharged rate each month. At least one seat.
 */
export function perIntervalAmount(
  tier: string,
  seats: number,
  billingPeriod: string,
): { amount: number; interval: string } {
  const cap = getCapacity(tier);
  if (!cap || cap.priceEurMonthly === null) throw new BillingError(`tier ${tier} is not payable`);
  const n = Math.max(seats, 1);
  if (billingPeriod === "monthly") {
    return {
      amount: pyRound(computeMonthlyBillingPrice(cap.priceEurMonthly) * n, 2),
      interval: "1 month",
    };
  }
  return { amount: pyRound(cap.priceEurMonthly * 12 * n, 2), interval: "12 months" };
}

/** The line Mollie shows on checkout and on each charge; it has to read like a receipt. */
export function planDescription(tier: string, seats: number, billingPeriod: string): string {
  const label = tier ? tier.charAt(0).toUpperCase() + tier.slice(1).toLowerCase() : tier;
  const seatTxt = `${seats} seat${seats !== 1 ? "s" : ""}`;
  const cadence = billingPeriod === "monthly" ? "billed monthly" : "billed yearly";
  const renews = billingPeriod === "monthly" ? "renews monthly" : "renews yearly";
  return `${label} plan. ${seatTxt}, ${cadence}, ${renews}. Cancel anytime.`;
}

/** What staff would invoice a managed account for `seats`; null when the tier has no price. */
export function managedNextInvoiceAmount(
  account: { tier: string | null; billing_period: string | null },
  seats: number,
): number | null {
  const tier = account.tier;
  if (!tier || tier === "free") return null;
  try {
    return perIntervalAmount(tier, seats, account.billing_period || "annual").amount;
  } catch {
    return null;
  }
}

/**
 * First recurring charge date (YYYY-MM-DD), one full period after today in UTC, clamped
 * to the month's last day. The consent payment already paid period one.
 */
export function subscriptionStartDate(billingPeriod: string | null, now: Date): string {
  const months = billingPeriod === "annual" ? 12 : 1;
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const targetY = y + Math.floor((m + months) / 12);
  const targetM = (m + months) % 12;
  const lastDay = new Date(Date.UTC(targetY, targetM + 1, 0)).getUTCDate();
  const d = Math.min(now.getUTCDate(), lastDay);
  return `${String(targetY).padStart(4, "0")}-${String(targetM + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Fallback period end when Mollie cannot say: a year for annual, else 30 days. */
export function periodEndIso(billingPeriod: string | null, now: Date): string {
  const days = billingPeriod === "annual" ? 365 : 30;
  return pyIso(new Date(now.getTime() + days * 86_400_000));
}

/** datetime.isoformat() of an aware UTC datetime: microseconds and +00:00, as Python wrote it. */
export function pyIso(d: Date): string {
  const s = d.toISOString(); // 2026-09-27T10:11:12.345Z
  return `${s.slice(0, 23)}000+00:00`;
}
