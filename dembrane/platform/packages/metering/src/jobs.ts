import type { Db } from "@dembrane/db";
import {
  embeddingModelOf,
  groupsOf,
  type LlmSettings,
  type TranscriptionProfile,
} from "@dembrane/llm";
import type { Logger } from "@dembrane/observability";
import { defineJob, type JobDefinition, type Queue } from "@dembrane/queue";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { PriceBook } from "./prices/store";
import { syncPrices } from "./prices/sync";
import { type FetchText, httpText, postSlack } from "./slack";

/** Daily at 03:15 UTC, once across workers. */
export const priceSync = defineJob("metering.price-sync", z.object({}), {
  policy: "singleton",
  retryLimit: 2,
  expireInSeconds: 10 * 60,
});
const PRICE_SYNC_CRON = "15 3 * * *";

/** Daily at 00:30 UTC, once across workers: rolls up yesterday and prunes old model_call rows. */
export const spendRollup = defineJob("metering.spend-rollup", z.object({}), {
  policy: "singleton",
  retryLimit: 2,
  expireInSeconds: 30 * 60,
});
const SPEND_ROLLUP_CRON = "30 0 * * *";

export interface MeteringJobDeps {
  readonly db: Db;
  readonly logger: Logger;
  readonly slackUrl: string | null;
  readonly modelsDevUrl: string;
  readonly ecbUrl: string;
  /** This process's book, reloaded right after each sync. */
  readonly book?: PriceBook;
  readonly fetchText?: FetchText;
}

export function meteringRegistration(d: MeteringJobDeps): {
  readonly jobs: readonly JobDefinition[];
  register(queue: Queue): Promise<void>;
} {
  return {
    jobs: [priceSync, spendRollup],
    async register(queue) {
      await queue.work(priceSync, { concurrency: 1 }, async () => {
        await syncPrices({
          db: d.db,
          logger: d.logger,
          slackUrl: d.slackUrl,
          modelsDevUrl: d.modelsDevUrl,
          ecbUrl: d.ecbUrl,
          fetchText: d.fetchText ?? httpText,
          now: () => new Date(),
        });
        await d.book?.reload();
      });
      await queue.schedule(priceSync, PRICE_SYNC_CRON, {}, "UTC");
      await queue.work(spendRollup, { concurrency: 1 }, async () => {
        await runSpendRollup({
          db: d.db,
          logger: d.logger,
          slackUrl: d.slackUrl,
          now: () => new Date(),
        });
      });
      await queue.schedule(spendRollup, SPEND_ROLLUP_CRON, {}, "UTC");
    },
  };
}

const DAY_MS = 86_400_000;
const UNATTRIBUTED_ALERT_SHARE = 0.01;
/** Complete UTC days each run rolls up, so a missed run is filled by the next. */
const ROLLUP_DAYS = 3;

/** Upserts model_call totals for the UTC days in [from, to); every column is replaced, so a rerun gives the same rows. */
async function rollUpDays(db: Db, from: Date, to: Date): Promise<number> {
  const rows = await db.execute(sql`
    insert into ai_spend_daily
      (day, billing_account_id, payer, operation, model, calls, input_tokens, output_tokens, cost_micro_eur)
    select (started_at at time zone 'UTC')::date, billing_account_id, payer, coalesce(operation, ''), model,
      count(*)::int, coalesce(sum(input_tokens), 0), coalesce(sum(output_tokens), 0),
      coalesce(sum(cost_micro_eur), 0)
    from model_call
    where started_at >= ${from.toISOString()}::timestamptz and started_at < ${to.toISOString()}::timestamptz
    group by (started_at at time zone 'UTC')::date, billing_account_id, payer, coalesce(operation, ''), model
    on conflict (day, coalesce(billing_account_id, '00000000-0000-0000-0000-000000000000'::uuid), payer, operation, model)
    do update set calls = excluded.calls, input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens, cost_micro_eur = excluded.cost_micro_eur
    returning 1`);
  return rows.length;
}

/** Upserts the last complete UTC days' totals, deletes model_call rows past keepDays in batches, and alerts on yesterday's unattributed spend. */
export async function runSpendRollup(d: {
  db: Db;
  logger: Logger;
  slackUrl: string | null;
  now: () => Date;
  keepDays?: number;
  batch?: number;
}): Promise<{ rolledUp: number; deleted: number; unattributedShare: number }> {
  const now = d.now();
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(to.getTime() - DAY_MS);
  const rollFrom = new Date(to.getTime() - ROLLUP_DAYS * DAY_MS);
  const day = from.toISOString().slice(0, 10);

  // Older days with calls but no totals (the first run, or a long outage) are totalled one
  // per statement before the prune below can delete them.
  let rolledUp = 0;
  const missing = await d.db.execute<{ day: string }>(sql`
    select to_char(g, 'YYYY-MM-DD') as day
    from generate_series(
      (select (min(started_at) at time zone 'UTC')::date from model_call),
      ${rollFrom.toISOString().slice(0, 10)}::date - 1, interval '1 day') g
    where not exists (select 1 from ai_spend_daily s where s.day = g::date)`);
  for (const { day: gap } of missing) {
    const start = new Date(`${gap}T00:00:00Z`);
    rolledUp += await rollUpDays(d.db, start, new Date(start.getTime() + DAY_MS));
  }
  if (missing.length > 0) d.logger.info({ days: missing.length }, "AI spend backfilled");
  rolledUp += await rollUpDays(d.db, rollFrom, to);

  const [share] = await d.db.execute<{ total: string; unattributed: string }>(sql`
    select coalesce(sum(cost_micro_eur), 0)::text as total,
      coalesce(sum(cost_micro_eur) filter (where payer = 'unattributed'), 0)::text as unattributed
    from model_call
    where started_at >= ${from.toISOString()}::timestamptz and started_at < ${to.toISOString()}::timestamptz`);
  const total = Number(share?.total ?? 0);
  const unattributed = Number(share?.unattributed ?? 0);
  const unattributedShare = total > 0 ? unattributed / total : 0;

  // Small batches, each its own statement, so no long lock on model_call.
  const cutoff = new Date(now.getTime() - (d.keepDays ?? 90) * DAY_MS).toISOString();
  const batch = d.batch ?? 5000;
  let deleted = 0;
  for (;;) {
    const gone = await d.db.execute(sql`
      delete from model_call where id in (
        select id from model_call where started_at < ${cutoff}::timestamptz limit ${batch})
      returning 1`);
    deleted += gone.length;
    if (gone.length < batch) break;
  }

  d.logger.info({ day, rolledUp, deleted, unattributedShare }, "AI spend rolled up");
  if (unattributedShare > UNATTRIBUTED_ALERT_SHARE) {
    const pct = (unattributedShare * 100).toFixed(1);
    const euros = `EUR ${(unattributed / 1_000_000).toFixed(2)}`;
    await postSlack(
      d.slackUrl,
      `Unattributed AI spend yesterday: ${pct}% (${euros}). Check model_call rows with payer 'unattributed'.`,
      d.logger,
    );
  }
  return { rolledUp, deleted, unattributedShare };
}

/** Every "provider/model" this deployment can call: its model groups, embeddings and transcription. */
export function configuredModels(s: LlmSettings, profile: TranscriptionProfile): string[] {
  const out = new Set<string>();
  const provider = s.provider;
  for (const ids of Object.values(groupsOf(s))) for (const m of ids) out.add(`${provider}/${m}`);
  out.add(`${provider}/${embeddingModelOf(s)}`);
  for (const speech of [profile.live, profile.redo]) {
    if (!speech) continue;
    if (speech.provider === "whisper") out.add(`openai-compatible/${speech.model}`);
    else {
      // Gemini speech runs on Vertex with the Pro group's models as its fallbacks.
      out.add(`vertex/${speech.model}`);
      for (const m of s.multiModalPro) out.add(`vertex/${m}`);
    }
  }
  if (profile.cleanUp) out.add(`openai-compatible/${profile.cleanUp.model}`);
  return [...out].sort();
}
