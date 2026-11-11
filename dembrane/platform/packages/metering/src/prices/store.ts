import { type Db, schema } from "@dembrane/db";
import type { Logger } from "@dembrane/observability";
import { desc } from "drizzle-orm";
import type { PriceRow, PriceSnapshot, UnitPrices } from "./book";

export interface PriceBook {
  /** The prices every call is charged at; never reads the database. */
  current(): PriceSnapshot;
  /** Reads the newest row per model and the latest rate; a failure keeps the last snapshot. */
  reload(): Promise<void>;
  /** The given "provider/model" keys the book holds no price for. */
  missing(models: readonly string[]): string[];
}

/** Until a rate is stored a dollar counts as a euro, which never under-counts. */
export const FALLBACK_USD_TO_EUR = 1;
const RELOAD_MS = 5 * 60 * 1000;

type Stored = typeof schema.ai_price.$inferSelect;
type Columns = Omit<typeof schema.ai_price.$inferInsert, "id" | "provider" | "model" | "source">;

const num = (v: string | null): number | null => (v === null ? null : Number(v));
const str = (v: number | null): string | null => (v === null ? null : String(v));

/** Unit prices as ai_price columns. */
export function toColumns(p: UnitPrices): Omit<Columns, "effective_from"> {
  const lc = p.longContext;
  return {
    currency: p.currency,
    input_per_m: str(p.inputPerM),
    cached_input_per_m: str(p.cachedInputPerM),
    audio_input_per_m: str(p.audioInputPerM),
    output_per_m: str(p.outputPerM),
    long_context_threshold: lc?.threshold ?? null,
    long_input_per_m: str(lc?.inputPerM ?? null),
    long_cached_input_per_m: str(lc?.cachedInputPerM ?? null),
    long_output_per_m: str(lc?.outputPerM ?? null),
    per_audio_second: str(p.perAudioSecond),
    per_search_query: str(p.perSearchQuery),
  };
}

/** A stored ai_price row; numeric columns come back as strings. */
export function fromStored(r: Stored): PriceRow {
  const longInput = num(r.long_input_per_m);
  const longOutput = num(r.long_output_per_m);
  return {
    id: r.id,
    provider: r.provider,
    model: r.model,
    source: r.source as PriceRow["source"],
    effectiveFrom: r.effective_from,
    currency: r.currency as UnitPrices["currency"],
    inputPerM: num(r.input_per_m),
    cachedInputPerM: num(r.cached_input_per_m),
    audioInputPerM: num(r.audio_input_per_m),
    outputPerM: num(r.output_per_m),
    longContext:
      r.long_context_threshold !== null && longInput !== null && longOutput !== null
        ? {
            threshold: r.long_context_threshold,
            inputPerM: longInput,
            cachedInputPerM: num(r.long_cached_input_per_m),
            outputPerM: longOutput,
          }
        : null,
    perAudioSecond: num(r.per_audio_second),
    perSearchQuery: num(r.per_search_query),
  };
}

/** The newest ai_price row per provider and model, keyed "provider/model". */
export async function latestPrices(db: Db): Promise<Map<string, PriceRow>> {
  const t = schema.ai_price;
  const rows = await db
    .selectDistinctOn([t.provider, t.model])
    .from(t)
    .orderBy(t.provider, t.model, desc(t.effective_from), desc(t.id));
  return new Map(rows.map((r) => [`${r.provider}/${r.model}`, fromStored(r)]));
}

/** The most recent stored USD to EUR rate, or null when none is stored. */
export async function latestRate(db: Db): Promise<number | null> {
  const [row] = await db
    .select({ rate: schema.ai_fx_rate.usd_to_eur })
    .from(schema.ai_fx_rate)
    .orderBy(desc(schema.ai_fx_rate.day))
    .limit(1);
  return row ? Number(row.rate) : null;
}

/** The in-memory price table every process prices calls from, reloaded every few minutes. */
export function priceBook(db: Db, logger: Logger, opts: { reloadMs?: number } = {}): PriceBook {
  let snap: PriceSnapshot = { prices: new Map(), usdToEur: FALLBACK_USD_TO_EUR };
  let warnedRate = false;

  const reload = async () => {
    try {
      const [prices, rate] = await Promise.all([latestPrices(db), latestRate(db)]);
      if (rate === null && prices.size && !warnedRate) {
        warnedRate = true;
        logger.warn({ fallback: FALLBACK_USD_TO_EUR }, "no USD to EUR rate stored; using fallback");
      }
      snap = { prices, usdToEur: rate ?? FALLBACK_USD_TO_EUR };
    } catch (err) {
      logger.warn({ err }, "AI prices could not be reloaded; keeping the last ones");
    }
  };

  const timer = setInterval(() => void reload(), opts.reloadMs ?? RELOAD_MS);
  (timer as { unref?: () => void }).unref?.();

  return {
    current: () => snap,
    reload,
    missing: (models) => models.filter((m) => !snap.prices.has(m)),
  };
}
