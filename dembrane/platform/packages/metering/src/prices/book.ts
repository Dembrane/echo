import file from "../../prices/overrides.json" with { type: "json" };

/** Per-million token prices, per audio second and per search lookup, in one currency. */
export interface UnitPrices {
  readonly currency: "USD" | "EUR";
  readonly inputPerM: number | null;
  readonly cachedInputPerM: number | null;
  readonly audioInputPerM: number | null;
  readonly outputPerM: number | null;
  /** Prices for the whole call once its input tokens pass the threshold. */
  readonly longContext: {
    threshold: number;
    inputPerM: number;
    cachedInputPerM: number | null;
    outputPerM: number;
  } | null;
  readonly perAudioSecond: number | null;
  readonly perSearchQuery: number | null;
}

export interface PriceRow extends UnitPrices {
  readonly id: number;
  readonly provider: string;
  readonly model: string;
  readonly source: "models.dev" | "override";
  readonly effectiveFrom: Date;
}

/** Prices keyed "provider/model", and what one dollar is in euros. */
export interface PriceSnapshot {
  readonly prices: ReadonlyMap<string, PriceRow>;
  readonly usdToEur: number;
}

export interface OverrideFile {
  /** Keyed "provider/model" as our config names it. */
  readonly models: Record<
    string,
    { provider: string } & ({ modelsDev: string } | { prices: UnitPrices })
  >;
  readonly searchQuery: { provider: string; currency: "USD" | "EUR"; perQuery: number };
}

const currency = (v: unknown): v is "USD" | "EUR" => v === "USD" || v === "EUR";

/** The hand-kept prices/overrides.json; throws on an entry that is neither mapped nor priced. */
export function loadOverrides(): OverrideFile {
  const f = file as unknown as OverrideFile;
  for (const [key, entry] of Object.entries(f.models)) {
    const ok =
      typeof entry.provider === "string" &&
      ("modelsDev" in entry
        ? typeof entry.modelsDev === "string"
        : "prices" in entry && currency(entry.prices.currency));
    if (!ok) throw new Error(`prices/overrides.json: ${key} needs modelsDev or prices`);
  }
  if (!currency(f.searchQuery.currency) || typeof f.searchQuery.perQuery !== "number")
    throw new Error("prices/overrides.json: searchQuery needs a currency and perQuery");
  return f;
}
