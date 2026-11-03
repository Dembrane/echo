import type { ModelCall } from "@dembrane/llm";
import type { PriceSnapshot, UnitPrices } from "./book";

export interface CallCost {
  readonly costMicroEur: number;
  /** The ai_price row used; null when nothing was priced or the model has no row. */
  readonly priceId: number | null;
  readonly priceMissing: boolean;
}

/** Micro-euros per token, per audio second and per lookup (a price per million tokens is micro-units per token). */
interface Rates {
  readonly text: number;
  readonly cached: number;
  readonly audio: number;
  readonly output: number;
  readonly second: number;
  readonly query: number;
}

const n = (v: number | null) => v ?? 0;

/** One row's rates, its long-context tier when the call's input passes the threshold. */
function rates(p: UnitPrices, inputTokens: number, usdToEur: number): Rates {
  const fx = p.currency === "USD" ? usdToEur : 1;
  const lc = p.longContext && inputTokens > p.longContext.threshold ? p.longContext : null;
  const input = n(lc ? lc.inputPerM : p.inputPerM);
  return {
    text: input * fx,
    cached: n(lc ? (lc.cachedInputPerM ?? lc.inputPerM) : (p.cachedInputPerM ?? p.inputPerM)) * fx,
    // The long tier has no audio price of its own: audio goes at its long input price.
    audio: n(lc ? lc.inputPerM : (p.audioInputPerM ?? p.inputPerM)) * fx,
    output: n(lc ? lc.outputPerM : p.outputPerM) * fx,
    second: n(p.perAudioSecond) * 1e6 * fx,
    query: n(p.perSearchQuery) * 1e6 * fx,
  };
}

/** The highest rate per unit across every row, normal and long-context tiers alike. */
function highest(snap: PriceSnapshot): Rates {
  const all = [...snap.prices.values()].flatMap((p) => [
    rates(p, 0, snap.usdToEur),
    rates(p, Number.POSITIVE_INFINITY, snap.usdToEur),
  ]);
  const max = (k: keyof Rates) => Math.max(0, ...all.map((r) => r[k]));
  return {
    text: max("text"),
    cached: max("cached"),
    audio: max("audio"),
    output: max("output"),
    second: max("second"),
    query: max("query"),
  };
}

/** What one model call cost in micro-euros, rounded up. */
export function priceCall(call: ModelCall, snap: PriceSnapshot): CallCost {
  const usage = [
    call.inputTokens,
    call.cachedInputTokens,
    call.audioInputTokens,
    call.outputTokens,
    call.audioSeconds,
    call.searchQueries,
  ];
  if (usage.every((v) => v === null))
    return { costMicroEur: 0, priceId: null, priceMissing: false };

  const row = snap.prices.get(`${call.provider}/${call.model}`);
  const input = Math.max(0, n(call.inputTokens));
  const r = row ? rates(row, input, snap.usdToEur) : highest(snap);
  // Each input token is priced once: cached first, then audio up to what is left, then text.
  const cached = Math.min(Math.max(0, n(call.cachedInputTokens)), input);
  const audio = Math.min(Math.max(0, n(call.audioInputTokens)), input - cached);
  const text = input - cached - audio;
  const micro =
    text * r.text +
    cached * r.cached +
    audio * r.audio +
    Math.max(0, n(call.outputTokens)) * r.output +
    Math.max(0, n(call.audioSeconds)) * r.second +
    Math.max(0, n(call.searchQueries)) * r.query;
  // Drop float noise below a millionth of a micro-euro before rounding up.
  const costMicroEur = Math.ceil(Math.round(micro * 1e6) / 1e6);
  return { costMicroEur, priceId: row?.id ?? null, priceMissing: !row };
}
