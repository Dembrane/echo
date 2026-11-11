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
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const numOrNull = (v: unknown) => v === null || num(v);
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const ENTRY_KEYS = new Set(["provider", "modelsDev", "prices", "_source"]);
const UNIT_KEYS = [
  "inputPerM",
  "cachedInputPerM",
  "audioInputPerM",
  "outputPerM",
  "perAudioSecond",
  "perSearchQuery",
] as const;
const PRICE_KEYS = new Set<string>(["currency", "longContext", ...UNIT_KEYS]);
const LONG_KEYS = new Set(["threshold", "inputPerM", "cachedInputPerM", "outputPerM"]);

// Every key known, every unit a number or null, and something above 0 to charge.
function priceProblem(p: unknown): string | null {
  if (!isObject(p)) return "prices must be an object";
  const unknown = Object.keys(p).filter((k) => !PRICE_KEYS.has(k));
  if (unknown.length) return `unknown price keys ${unknown.join(", ")}`;
  if (!currency(p.currency)) return "currency must be USD or EUR";
  for (const k of UNIT_KEYS) if (!numOrNull(p[k])) return `${k} must be a number or null`;
  const lc = p.longContext;
  if (lc !== null) {
    if (!isObject(lc)) return "longContext must be an object or null";
    const bad = Object.keys(lc).filter((k) => !LONG_KEYS.has(k));
    if (
      bad.length ||
      !num(lc.threshold) ||
      !num(lc.inputPerM) ||
      !num(lc.outputPerM) ||
      !numOrNull(lc.cachedInputPerM)
    )
      return "longContext needs threshold, inputPerM, cachedInputPerM and outputPerM";
  }
  if (!UNIT_KEYS.some((k) => (p[k] as number | null) !== null && (p[k] as number) > 0))
    return "no unit price above 0";
  return null;
}

/** Checks a parsed overrides file; throws naming the entry and the problem. */
export function checkOverrides(raw: unknown): OverrideFile {
  const f = raw as OverrideFile;
  if (!isObject(raw) || !isObject(f.models) || !isObject(f.searchQuery))
    throw new Error("prices/overrides.json needs models and searchQuery");
  for (const [key, entry] of Object.entries(f.models as Record<string, unknown>)) {
    if (!isObject(entry) || typeof entry.provider !== "string")
      throw new Error(`prices/overrides.json: ${key} needs a provider`);
    const unknown = Object.keys(entry).filter((k) => !ENTRY_KEYS.has(k));
    if (unknown.length)
      throw new Error(`prices/overrides.json: ${key} has unknown keys ${unknown.join(", ")}`);
    if ("modelsDev" in entry) {
      if (typeof entry.modelsDev !== "string" || "prices" in entry)
        throw new Error(`prices/overrides.json: ${key} needs modelsDev or prices`);
      continue;
    }
    if (!("prices" in entry))
      throw new Error(`prices/overrides.json: ${key} needs modelsDev or prices`);
    const problem = priceProblem(entry.prices);
    if (problem) throw new Error(`prices/overrides.json: ${key}: ${problem}`);
  }
  if (!currency(f.searchQuery.currency) || !num(f.searchQuery.perQuery))
    throw new Error("prices/overrides.json: searchQuery needs a currency and perQuery");
  return f;
}

/** The hand-kept prices/overrides.json; throws on an entry that is neither mapped nor priced right. */
export function loadOverrides(): OverrideFile {
  return checkOverrides(file);
}
