import type { OverrideFile, UnitPrices } from "./book";

type Cost = Record<string, unknown>;

const LONG_CONTEXT_DEFAULT = 200000;

const price = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

const record = (v: unknown): Cost | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Cost) : null;

/** The context tier models.dev lists (tiers first, then context_over_200k), as long-context prices. */
function longContext(cost: Cost): UnitPrices["longContext"] {
  const tiers = Array.isArray(cost.tiers) ? cost.tiers : [];
  const tier = tiers
    .map(record)
    .find((t) => record(t?.tier)?.type === "context" && price(record(t?.tier)?.size) !== null);
  const over = tier ?? record(cost.context_over_200k);
  if (!over) return null;
  const inputPerM = price(over.input);
  const outputPerM = price(over.output);
  if (inputPerM === null || outputPerM === null) return null;
  const threshold = tier ? (price(record(tier.tier)?.size) as number) : LONG_CONTEXT_DEFAULT;
  return { threshold, inputPerM, cachedInputPerM: price(over.cache_read), outputPerM };
}

/**
 * Unit prices in dollars for every mapped model models.dev lists. Models priced by hand,
 * and models the source lacks or lists without input and output prices, are left out.
 */
export function pricesFromModelsDev(
  api: unknown,
  mapping: OverrideFile["models"],
): Map<string, UnitPrices> {
  const out = new Map<string, UnitPrices>();
  const root = record(api);
  if (!root) return out;
  for (const [key, entry] of Object.entries(mapping)) {
    if (!("modelsDev" in entry)) continue;
    const slash = entry.modelsDev.indexOf("/");
    const provider = entry.modelsDev.slice(0, slash);
    const model = entry.modelsDev.slice(slash + 1);
    const cost = record(record(record(record(root[provider])?.models)?.[model])?.cost);
    if (!cost) continue;
    const inputPerM = price(cost.input);
    const outputPerM = price(cost.output);
    if (inputPerM === null || outputPerM === null) continue;
    out.set(key, {
      currency: "USD",
      inputPerM,
      cachedInputPerM: price(cost.cache_read),
      audioInputPerM: price(cost.input_audio),
      outputPerM,
      longContext: longContext(cost),
      perAudioSecond: null,
      perSearchQuery: null,
    });
  }
  return out;
}
