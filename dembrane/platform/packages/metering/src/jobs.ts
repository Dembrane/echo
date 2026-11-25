import type { Db } from "@dembrane/db";
import {
  embeddingModelOf,
  groupsOf,
  isJob,
  JOBS,
  type Job,
  type LlmSettings,
  type ProviderId,
  serves,
  type TranscriptionProfile,
} from "@dembrane/llm";
import type { Logger } from "@dembrane/observability";
import { defineJob, type JobDefinition, type Queue } from "@dembrane/queue";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { type CostAlertSink, type FetchText, httpText, postCostAlert } from "./alerts";
import { syncFeatureRules } from "./feature-rules";
import type { PriceBook } from "./prices/store";
import { syncPrices } from "./prices/sync";

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

/** Daily at 04:00 UTC, once across workers: proves every Google call since the last check was meant for Google. */
export const providerCheck = defineJob("metering.provider-check", z.object({}), {
  policy: "singleton",
  retryLimit: 2,
  expireInSeconds: 10 * 60,
});
const PROVIDER_CHECK_CRON = "0 4 * * *";

export interface MeteringJobDeps {
  readonly db: Db;
  /** The deployment's default provider; where it is Google, a call to Google needs no opt-in to be right. */
  readonly defaultProvider?: ProviderId;
  readonly logger: Logger;
  /** sam's inbox for the alerts; null logs them only. */
  readonly alerts: CostAlertSink | null;
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
    jobs: [priceSync, spendRollup, providerCheck],
    async register(queue) {
      // The table only feeds dashboards: a failed sync never stops the jobs.
      try {
        d.logger.info({ rules: await syncFeatureRules(d.db) }, "AI feature rules synced");
      } catch (err) {
        d.logger.error({ err }, "AI feature rules could not be synced");
      }
      await queue.work(priceSync, { concurrency: 1 }, async () => {
        await syncPrices({
          db: d.db,
          logger: d.logger,
          alerts: d.alerts,
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
          alerts: d.alerts,
          now: () => new Date(),
        });
      });
      await queue.schedule(spendRollup, SPEND_ROLLUP_CRON, {}, "UTC");
      await queue.work(providerCheck, { concurrency: 1 }, async () => {
        await runProviderCheck({
          db: d.db,
          logger: d.logger,
          alerts: d.alerts,
          now: () => new Date(),
          defaultProvider: d.defaultProvider ?? "scaleway",
        });
      });
      await queue.schedule(providerCheck, PROVIDER_CHECK_CRON, {}, "UTC");
    },
  };
}

const DAY_MS = 86_400_000;

/** The check's place in ai_provider_check: everything before this instant has been read. */
const CHECK_NAME = "provider-check";
/**
 * The check reads rows by when they were written (model_call.recorded_at), which is after the
 * call ended, so a long call is read by the run after it finishes, never skipped. It still
 * stops this far short of now: a row's write may commit a moment after its clock reading.
 */
const CHECK_LAG_MS = 15 * 60_000;

/**
 * Counts the Google (Vertex) calls since the last check that were not meant for Google. It
 * must be zero: anything else raises the AI cost alert to sam's inbox. A call counts when the
 * policy recorded a destination other than Google, and, where Google needs an opt-in, when the
 * account's own history says Google was not allowed for the call's job at that moment: the
 * providers the account had enabled for that job and its default for it, the project's choice for that
 * job (and whether a later removal of Google cleared it) from account_event, and, for audio, the
 * provider the conversation began on. That is read again here, independently of what the call
 * recorded about itself. Where Google is the deployment's default, a call there needs no opt-in,
 * so only calls the policy sent elsewhere count.
 *
 * It reads from where the last run stopped, so a day the job did not run is covered by the
 * next one; the first run, which has no place saved, reads the last 24 hours. The place is
 * saved only after the alert went out.
 */
export async function runProviderCheck(d: {
  db: Db;
  logger: Logger;
  alerts: CostAlertSink | null;
  now: () => Date;
  defaultProvider: ProviderId;
  /** How far behind now the check stops; the default leaves time for rows still being written. */
  lagMs?: number;
}): Promise<{ leaks: number; byJob: Record<Job, number> }> {
  const now = d.now();
  const until = new Date(now.getTime() - (d.lagMs ?? CHECK_LAG_MS)).toISOString();
  const [mark] = await d.db.execute<{ checked_through: Date }>(
    sql`select checked_through from ai_provider_check where name = ${CHECK_NAME}`,
  );
  // With no place saved the check reads the last day only: rows written before the policy
  // recorded its destination have none, and counting the whole log would call them leaks.
  const since = new Date(
    mark ? new Date(mark.checked_through).getTime() : now.getTime() - DAY_MS,
  ).toISOString();
  const optInNeeded = d.defaultProvider !== "google";
  const defaultIsGoogle = d.defaultProvider === "google";
  const googleJobs = JOBS.filter((j) => serves("google", j));
  const rows = await d.db.execute<{
    job: string;
    leaks: number;
    organisations: string[] | null;
    ids: (number | string)[] | null;
  }>(sql`
    with calls as (
      select id, started_at, organisation_id, project_id, routing_conversation_id, routed_provider,
        coalesce(routing_job, '') as job
      from model_call
      where recorded_at >= ${since}::timestamptz and recorded_at < ${until}::timestamptz
        and provider = 'vertex'
    ),
    judged as (
      select c.*,
        -- The account's setting when the call was made; none recorded means the deployment's own.
        coalesce(
          (oe.setting -> 'enabled' -> c.job) @> '["google"]'::jsonb,
          ${defaultIsGoogle}
        ) as google_allowed,
        coalesce(oe.setting -> 'defaults' ->> c.job, ${d.defaultProvider}) as account_default,
        -- The project's own choice for this job then; a later removal of Google from the account cleared it.
        case when pe.at is null or (rm.at is not null and rm.at > pe.at) then null else pe.choice end as project_choice,
        cv.ai_transcription_provider as conversation_provider
      from calls c
      left join lateral (
        select e.detail::jsonb -> 'after' as setting from account_event e
        where e.org_id = c.organisation_id and e.type = 'ai_providers.changed' and e.created_at <= c.started_at
        order by e.created_at desc limit 1) oe on true
      left join lateral (
        select max(e.created_at) as at from account_event e
        where e.org_id = c.organisation_id and e.type = 'ai_providers.changed' and e.created_at <= c.started_at
          and (e.detail::jsonb -> 'before' -> 'enabled' -> c.job) @> '["google"]'::jsonb
          and not ((e.detail::jsonb -> 'after' -> 'enabled' -> c.job) @> '["google"]'::jsonb)) rm on true
      left join lateral (
        select e.created_at as at, e.detail::jsonb ->> 'after' as choice from account_event e
        where e.org_id = c.organisation_id and e.type = 'project.ai_provider.changed'
          and e.subject_id = c.project_id::text and e.detail::jsonb ->> 'job' = c.job
          and e.created_at <= c.started_at
        order by e.created_at desc limit 1) pe on true
      left join lateral (
        select v.ai_transcription_provider from conversation v where v.id = c.routing_conversation_id) cv on true
    )
    select job, count(*)::int as leaks,
      array_agg(distinct organisation_id::text) filter (where organisation_id is not null) as organisations,
      (array_agg(id order by id))[1:20] as ids
    from judged
    where routed_provider is distinct from 'google'
      or (${optInNeeded} and not (
        organisation_id is not null
        and job = any(${sql.param(googleJobs)}::text[])
        and google_allowed
        and coalesce(project_choice = 'google' or (project_choice is null and account_default = 'google'), false)
        and (job <> 'transcription' or routing_conversation_id is null or coalesce(conversation_provider = 'google', false))))
    group by job`);
  const byJob = { transcription: 0, analysis: 0 } as Record<Job, number>;
  for (const r of rows) if (isJob(r.job)) byJob[r.job] += Number(r.leaks);
  const leaks = rows.reduce((n, r) => n + Number(r.leaks), 0);
  d.logger.info(
    { leaks, byJob, since, until, signal: "metering.provider_check" },
    "AI provider check",
  );
  if (leaks > 0) {
    const who = [...new Set(rows.flatMap((r) => r.organisations ?? []))].slice(0, 5).join(", ");
    const jobs = rows.map((r) => `${r.job || "unknown job"}: ${r.leaks}`).join(", ");
    // The query names the rows it flagged, so it finds exactly those, whichever rule flagged them.
    const ids = rows.flatMap((r) => (r.ids ?? []).map(Number)).sort((a, b) => a - b);
    const more = leaks > ids.length ? ` (the first ${ids.length} of ${leaks})` : "";
    await postCostAlert(
      d.alerts,
      `AI provider check: ${leaks} model call${leaks === 1 ? "" : "s"} since ${since} went to Google (Vertex) for a project the routing did not send there, or that its account's history did not allow Google for that job at that moment (${jobs}). Organisations: ${who || "none recorded"}. Rows${more}: select * from model_call where id in (${ids.join(", ")}).`,
      d.logger,
      now,
    );
  }
  await d.db.execute(sql`
    insert into ai_provider_check (name, checked_through) values (${CHECK_NAME}, ${until}::timestamptz)
    on conflict (name) do update set checked_through = excluded.checked_through`);
  return { leaks, byJob };
}
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
  alerts: CostAlertSink | null;
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
    await postCostAlert(
      d.alerts,
      `Unattributed AI spend yesterday: ${pct}% (${euros}). Check model_call rows with payer 'unattributed'.`,
      d.logger,
      now,
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
