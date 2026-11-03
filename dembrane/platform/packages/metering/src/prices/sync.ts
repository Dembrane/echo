import { type Db, schema } from "@dembrane/db";
import type { Logger } from "@dembrane/observability";
import { type FetchText, postSlack } from "../slack";
import { loadOverrides, type OverrideFile, type PriceRow, type UnitPrices } from "./book";
import { pricesFromModelsDev } from "./models-dev";
import { FALLBACK_USD_TO_EUR, latestPrices, latestRate, type PriceBook, toColumns } from "./store";

export interface SyncResult {
  /** "provider/model" keys that got a new ai_price row. */
  readonly changed: readonly string[];
  /** Keys whose new price was missing or zero; their last good price is kept. */
  readonly rejected: readonly string[];
  readonly fxChanged: boolean;
}

export interface SyncDeps {
  readonly db: Db;
  readonly fetchText: FetchText;
  readonly logger: Logger;
  readonly slackUrl: string | null;
  readonly modelsDevUrl: string;
  readonly ecbUrl: string;
  readonly now: () => Date;
  /** Defaults to prices/overrides.json. */
  readonly overrides?: OverrideFile;
}

type Flat = Record<
  | "input"
  | "cached"
  | "audio"
  | "output"
  | "threshold"
  | "longInput"
  | "longCached"
  | "longOutput"
  | "second"
  | "query",
  number | null
>;

/** Each price unit: its Slack label and what it is charged per. */
const UNITS: readonly [keyof Flat, string, string][] = [
  ["input", "input", "per million"],
  ["cached", "cached input", "per million"],
  ["audio", "audio input", "per million"],
  ["output", "output", "per million"],
  ["longInput", "long context input", "per million"],
  ["longCached", "long context cached input", "per million"],
  ["longOutput", "long context output", "per million"],
  ["second", "audio", "per second"],
  ["query", "search", "per lookup"],
];
const LARGE = 3;

const flat = (p: UnitPrices): Flat => ({
  input: p.inputPerM,
  cached: p.cachedInputPerM,
  audio: p.audioInputPerM,
  output: p.outputPerM,
  threshold: p.longContext?.threshold ?? null,
  longInput: p.longContext?.inputPerM ?? null,
  longCached: p.longContext?.cachedInputPerM ?? null,
  longOutput: p.longContext?.outputPerM ?? null,
  second: p.perAudioSecond,
  query: p.perSearchQuery,
});

const unflat = (currency: UnitPrices["currency"], f: Flat): UnitPrices => ({
  currency,
  inputPerM: f.input,
  cachedInputPerM: f.cached,
  audioInputPerM: f.audio,
  outputPerM: f.output,
  longContext:
    f.threshold !== null && f.longInput !== null && f.longOutput !== null
      ? {
          threshold: f.threshold,
          inputPerM: f.longInput,
          cachedInputPerM: f.longCached,
          outputPerM: f.longOutput,
        }
      : null,
  perAudioSecond: f.second,
  perSearchQuery: f.query,
});

const shown = (v: number | null) => (v === null ? "none" : String(v));
const large = (old: number | null, next: number | null) =>
  old !== null &&
  next !== null &&
  (old === 0 ? next > 0 : next / old > LARGE || next / old < 1 / LARGE);

/** The ECB's USD rate (dollars per euro) from its daily XML, or null when absent. */
export function ecbUsdRate(xml: string): number | null {
  const m = /currency=['"]USD['"]\s+rate=['"]([0-9.]+)['"]/.exec(xml);
  const rate = m ? Number(m[1]) : Number.NaN;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/** Stores today's USD to EUR rate; a failed or unreadable fetch keeps the last row. */
async function syncRate(d: SyncDeps): Promise<boolean> {
  let rate: number | null = null;
  try {
    rate = ecbUsdRate(await d.fetchText(d.ecbUrl));
    if (rate === null)
      d.logger.warn({ url: d.ecbUrl }, "ECB rates have no USD rate; keeping the last");
  } catch (err) {
    d.logger.warn({ err, url: d.ecbUrl }, "ECB rates unreachable; keeping the last");
  }
  if (rate === null) return false;
  const usdToEur = 1 / rate;
  const before = await latestRate(d.db);
  const day = d.now().toISOString().slice(0, 10);
  await d.db
    .insert(schema.ai_fx_rate)
    .values({ day, usd_to_eur: String(usdToEur), fetched_at: d.now() })
    .onConflictDoUpdate({
      target: schema.ai_fx_rate.day,
      set: { usd_to_eur: String(usdToEur), fetched_at: d.now() },
    });
  return before !== usdToEur;
}

/** models.dev's api.json, or null (with a warning) when it cannot be fetched or read. */
async function readModelsDev(d: SyncDeps): Promise<unknown> {
  try {
    const api: unknown = JSON.parse(await d.fetchText(d.modelsDevUrl));
    if (api && typeof api === "object" && !Array.isArray(api)) return api;
    d.logger.warn({ url: d.modelsDevUrl }, "models.dev answered something unreadable; prices kept");
  } catch (err) {
    d.logger.warn(
      { err, url: d.modelsDevUrl },
      "models.dev unreachable or unreadable; prices kept",
    );
  }
  return null;
}

/** The search lookup price in a row's currency. */
function searchPrice(sq: OverrideFile["searchQuery"], currency: string, usdToEur: number): number {
  if (sq.currency === currency) return sq.perQuery;
  return sq.currency === "USD" ? sq.perQuery * usdToEur : sq.perQuery / usdToEur;
}

/**
 * The daily sync: prices for every model in overrides.json, hand prices first, the rest from
 * models.dev. A new row is stored only when a price changed; a models.dev price that went
 * missing or to zero keeps the last good one. An unreadable source changes nothing it priced.
 */
export async function syncPrices(d: SyncDeps): Promise<SyncResult> {
  const overrides = d.overrides ?? loadOverrides();
  const fxChanged = await syncRate(d);
  const api = await readModelsDev(d);
  const fromSource = api ? pricesFromModelsDev(api, overrides.models) : null;
  const [stored, rate] = await Promise.all([latestPrices(d.db), latestRate(d.db)]);
  const usdToEur = rate ?? FALLBACK_USD_TO_EUR;
  const sq = overrides.searchQuery;

  const changed: string[] = [];
  const rejected: string[] = [];
  const texts: string[] = [];
  const inserts: (typeof schema.ai_price.$inferInsert)[] = [];
  const effectiveFrom = d.now();

  for (const [key, entry] of Object.entries(overrides.models)) {
    const prev: PriceRow | undefined = stored.get(key);
    const byHand = "prices" in entry;
    // An unreadable models.dev leaves its models as they are.
    if (!byHand && !fromSource) continue;
    const found = byHand ? entry.prices : fromSource?.get(key);
    if (!found) {
      if (prev) {
        rejected.push(key);
        texts.push(`${key} is no longer priced on models.dev; the last good price is kept`);
      } else d.logger.warn({ model: key }, "models.dev has no price for a configured model");
      continue;
    }
    const next = flat(found);
    if (entry.provider === sq.provider) next.query = searchPrice(sq, found.currency, usdToEur);

    // A models.dev unit that disappears or drops to zero keeps its last good price.
    const old = prev ? flat(prev) : null;
    const kept: string[] = [];
    if (old && !byHand && prev?.currency === found.currency) {
      for (const [unit, label] of UNITS) {
        const was = old[unit];
        const now = next[unit];
        if (was !== null && was > 0 && !(now !== null && now > 0)) {
          next[unit] = was;
          kept.push(label);
        }
      }
      if (next.threshold === null && (next.longInput !== null || next.longOutput !== null))
        next.threshold = old.threshold;
    }
    if (kept.length) {
      rejected.push(key);
      texts.push(
        `${key} ${kept.join(", ")} price from models.dev is missing or zero; the last good price is kept`,
      );
    }

    const diffs = old
      ? UNITS.filter(([unit]) => old[unit] !== next[unit]).map(([unit, label, per]) => {
          const line = `${key} ${label} price changed from ${shown(old[unit])} to ${shown(next[unit])} ${per}`;
          return large(old[unit], next[unit]) ? `Large change: ${line}` : line;
        })
      : [];
    if (old && old.threshold !== next.threshold)
      diffs.push(
        `${key} long context threshold changed from ${shown(old.threshold)} to ${shown(next.threshold)} tokens`,
      );
    if (prev && prev.currency !== found.currency)
      diffs.push(`${key} price currency changed from ${prev.currency} to ${found.currency}`);
    if (prev && !diffs.length) continue;

    const slash = key.indexOf("/");
    inserts.push({
      provider: entry.provider,
      model: key.slice(slash + 1),
      source: byHand ? "override" : "models.dev",
      effective_from: effectiveFrom,
      ...toColumns(unflat(found.currency, next)),
    });
    changed.push(key);
    texts.push(...diffs);
  }

  if (inserts.length) await d.db.insert(schema.ai_price).values(inserts).onConflictDoNothing();
  if (changed.length) d.logger.info({ changed, rejected }, "AI prices changed");
  else if (rejected.length) d.logger.warn({ rejected }, "AI prices rejected; last good kept");
  for (const text of texts) await postSlack(d.slackUrl, text, d.logger);
  return { changed, rejected, fxChanged };
}

/** What boot awaits: the book is loaded; the first sync and the missing-price check finish in `settled`. */
export interface PriceStartup {
  /** Never rejects. */
  readonly settled: Promise<void>;
}

/**
 * At boot: load the book (a database read). When any configured model has no stored price,
 * sync once in the background; after that, name any configured model still without one. Never throws.
 */
export async function priceStartup(
  d: SyncDeps,
  book: PriceBook,
  models: readonly string[],
): Promise<PriceStartup> {
  await book.reload();
  const unpriced = book.missing(models).length > 0;
  const settled = (async () => {
    let synced = false;
    if (unpriced) {
      try {
        await syncPrices(d);
        synced = true;
      } catch (err) {
        d.logger.error(
          { err, signal: "metering.price_sync_failed" },
          "AI price sync failed at startup",
        );
        await postSlack(
          d.slackUrl,
          `AI price sync failed at startup: ${(err as Error).message}`,
          d.logger,
        );
      }
      await book.reload();
    }
    const missing = book.missing(models);
    if (missing.length) {
      d.logger.error(
        { missing, signal: "metering.price_missing" },
        "configured models have no AI price",
      );
      await postSlack(
        d.slackUrl,
        synced
          ? `No AI price for ${missing.join(", ")} after a price sync. Their calls are charged at the highest price held until models.dev lists them or they get a hand price in prices/overrides.json.`
          : `No AI price for ${missing.join(", ")} yet. Their calls are charged at the highest price held until a price sync succeeds.`,
        d.logger,
      );
    }
  })().catch((err) => d.logger.error({ err }, "AI price startup check failed"));
  return { settled };
}
