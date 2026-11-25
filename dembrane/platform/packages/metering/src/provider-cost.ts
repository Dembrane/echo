import type { Db } from "@dembrane/db";
import {
  groupsOf,
  type Job,
  type LlmSettings,
  PROVIDERS,
  type ProviderId,
  settingsFor,
  type TranscriptionProfile,
} from "@dembrane/llm";
import { sql } from "drizzle-orm";
import type { PriceSnapshot } from "./prices/book";
import { priceCall } from "./prices/pricer";

/**
 * What a provider would cost an account, from the call log alone: model_call already carries
 * every call priced in euros, with its organisation, job and provider. Nothing here has a
 * ledger of its own.
 */

/** How far back an account's use is read for an estimate. */
export const WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;
const MICRO = 1_000_000;

/** The provider that answered a row: the one that billed it, else the one the policy chose. */
const PROVIDER_OF = sql.raw(
  `case when provider = 'vertex' then 'google' when provider = 'openai-compatible' then 'scaleway' else coalesce(routed_provider, 'scaleway') end`,
);
/** The job a row served; rows from before jobs were recorded read as speech (audio) or analysis (text). */
const JOB_OF = sql.raw(
  `coalesce(routing_job, case when kind = 'speech' or audio_seconds is not null then 'transcription' else 'analysis' end)`,
);
/** Audio seconds a row carried: its own count, else Gemini's 32 audio tokens a second. */
const AUDIO_SECONDS = sql.raw(`coalesce(audio_seconds, audio_input_tokens / 32.0, 0)`);

/** What an account (or one of its projects) used in the window. */
export interface Volume {
  /** Audio seconds sent for transcription. */
  readonly audioSeconds: number;
  /** Text calls for analysis, and the tokens they carried. */
  readonly calls: number;
  readonly tokens: number;
}

export const NO_VOLUME: Volume = { audioSeconds: 0, calls: 0, tokens: 0 };

/** What one provider costs per unit of a job, in euros. */
export interface UnitCost {
  /** Transcription: euros for one second of audio. */
  readonly perAudioSecond: number | null;
  /** Analysis: euros for one call, and for one token. */
  readonly perCall: number | null;
  readonly perToken: number | null;
}

export type UnitCosts = Readonly<Record<ProviderId, UnitCost>>;

const NO_UNIT: UnitCost = { perAudioSecond: null, perCall: null, perToken: null };

/**
 * The account's use of the last 30 days, per job. Transcription is the audio length of the
 * conversations started in the window, each counted once: the log's speech rows also carry
 * the second pass over a recording and the second listen to doubtful stretches, which only
 * some providers make, so summing them would count the same audio twice for those.
 * Analysis is the account's paid text calls. Empty for an account that has none.
 */
export async function accountVolume(
  db: Db,
  who: { organisationId: string; projectId?: string },
  now: Date,
): Promise<Volume> {
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS).toISOString();
  const [text, audio] = await Promise.all([
    db.execute<{ calls: number; tokens: number | null }>(sql`
      select count(*)::int as calls,
        sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0))::float8 as tokens
      from model_call
      where started_at >= ${since}::timestamptz and started_at <= ${now.toISOString()}::timestamptz
        and organisation_id = ${who.organisationId}::uuid
        and payer = 'account'
        and status = 'ok'
        and ${JOB_OF} = 'analysis'
        ${who.projectId ? sql`and project_id = ${who.projectId}::uuid` : sql``}`),
    db.execute<{ seconds: number | null }>(sql`
      select sum(c.duration)::float8 as seconds
      from conversation c
      join project p on p.id = c.project_id
      join workspace w on w.id = p.workspace_id
      where w.org_id = ${who.organisationId}::uuid
        and c.deleted_at is null and p.deleted_at is null
        and c.duration > 0
        and c.created_at >= ${since}::timestamptz and c.created_at <= ${now.toISOString()}::timestamptz
        ${who.projectId ? sql`and p.id = ${who.projectId}::uuid` : sql``}`),
  ]);
  return {
    audioSeconds: Number(audio[0]?.seconds ?? 0),
    calls: Number(text[0]?.calls ?? 0),
    tokens: Number(text[0]?.tokens ?? 0),
  };
}

/**
 * An average over accounts is shown only when this many distinct accounts stand behind it:
 * with fewer, the figure would be one account's own spend, which every reader of another
 * account's page could see. Below it the price list answers.
 */
export const MIN_ACCOUNTS_FOR_AVERAGE = 3;

/**
 * Each provider's average cost per unit over the last 30 days across every account in the log.
 * A provider with too little history for a job (see MIN_ACCOUNTS_FOR_AVERAGE) has null there;
 * the price list fills it in.
 */
export async function loggedUnitCosts(db: Db, now: Date): Promise<UnitCosts> {
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS).toISOString();
  const rows = await db.execute<{
    provider: string;
    job: string;
    cost: number | null;
    ok_calls: number;
    accounts: number;
    audio: number | null;
    tokens: number | null;
  }>(sql`
    select ${PROVIDER_OF} as provider, ${JOB_OF} as job,
      sum(coalesce(cost_micro_eur, 0))::float8 as cost,
      count(*) filter (where status = 'ok')::int as ok_calls,
      count(distinct organisation_id) filter (where status = 'ok')::int as accounts,
      sum(${AUDIO_SECONDS}) filter (where status = 'ok')::float8 as audio,
      sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)) filter (where status = 'ok')::float8 as tokens
    from model_call
    where started_at >= ${since}::timestamptz and started_at <= ${now.toISOString()}::timestamptz
      and payer = 'account'
    group by 1, 2`);
  const out: Record<ProviderId, UnitCost> = { scaleway: NO_UNIT, google: NO_UNIT };
  for (const id of Object.keys(PROVIDERS) as ProviderId[]) {
    const own = rows.filter(
      (r) => r.provider === id && Number(r.accounts) >= MIN_ACCOUNTS_FOR_AVERAGE,
    );
    const t = own.find((r) => r.job === "transcription");
    const a = own.find((r) => r.job === "analysis");
    const euros = (r: typeof t) => Number(r?.cost ?? 0) / MICRO;
    out[id] = {
      perAudioSecond: t && Number(t.audio) > 0 ? euros(t) / Number(t.audio) : null,
      perCall: a && a.ok_calls > 0 ? euros(a) / a.ok_calls : null,
      perToken: a && Number(a.tokens) > 0 ? euros(a) / Number(a.tokens) : null,
    };
  }
  return out;
}

/** What a typical analysis call carries when the price list stands in for history. */
const TYPICAL_CALL = { inputTokens: 4000, outputTokens: 600 };

/**
 * Unit costs from the price list, for a provider the log has no history for: speech priced on
 * the profile's live model, analysis on a typical call of the provider's fast text model.
 */
export function listedUnitCosts(
  snap: PriceSnapshot,
  s: LlmSettings,
  profileOf: (id: ProviderId) => TranscriptionProfile,
): UnitCosts {
  const out = {} as Record<ProviderId, UnitCost>;
  for (const id of Object.keys(PROVIDERS) as ProviderId[]) {
    const kind = PROVIDERS[id].kind;
    const own = settingsFor(s, id);
    const profile = profileOf(id);
    const speech = profile.live;
    const base = {
      attempt: 1,
      fallback: false,
      startedAt: new Date(0),
      service: "estimate",
      status: "ok",
    };
    const price = (call: Record<string, unknown>) =>
      priceCall(call as unknown as Parameters<typeof priceCall>[0], snap);
    const speechCost = price({
      ...base,
      provider: speech.provider === "whisper" ? "openai-compatible" : "vertex",
      model: speech.model,
      kind: "speech",
      inputTokens: speech.provider === "whisper" ? null : 32,
      audioInputTokens: speech.provider === "whisper" ? null : 32,
      outputTokens: speech.provider === "whisper" ? null : 4,
      audioSeconds: speech.provider === "whisper" ? 1 : null,
      cachedInputTokens: null,
      reasoningTokens: null,
      searchQueries: null,
    });
    const textModel = groupsOf(own).text_fast[0];
    const textCost = textModel
      ? price({
          ...base,
          provider: kind,
          model: textModel,
          kind: "generate",
          ...TYPICAL_CALL,
          audioInputTokens: null,
          cachedInputTokens: null,
          reasoningTokens: null,
          audioSeconds: null,
          searchQueries: null,
        })
      : null;
    const perCall = textCost && !textCost.priceMissing ? textCost.costMicroEur / MICRO : null;
    out[id] = {
      perAudioSecond: speechCost.priceMissing ? null : speechCost.costMicroEur / MICRO,
      perCall,
      perToken:
        perCall === null ? null : perCall / (TYPICAL_CALL.inputTokens + TYPICAL_CALL.outputTokens),
    };
  }
  return out;
}

/** Logged costs, with the price list where a provider has none yet. */
export function mergeUnitCosts(logged: UnitCosts, listed: UnitCosts | null): UnitCosts {
  const out = {} as Record<ProviderId, UnitCost>;
  for (const id of Object.keys(PROVIDERS) as ProviderId[]) {
    const l = logged[id] ?? NO_UNIT;
    const p = listed?.[id] ?? NO_UNIT;
    out[id] = {
      perAudioSecond: l.perAudioSecond ?? p.perAudioSecond,
      perCall: l.perCall ?? p.perCall,
      perToken: l.perToken ?? p.perToken,
    };
  }
  return out;
}

/**
 * What one provider costs for one job, as a screen shows it: a monthly figure at the account's
 * own use of the last 30 days, or, when it has none for that job, the cost of one hour of audio
 * and of 100 analysis calls. Nothing here is a token count a person sees.
 */
export interface CostLine {
  readonly job: Job;
  readonly provider: ProviderId;
  /** "included" in the plan, or "on_top" of it and billed at cost. */
  readonly billing: "included" | "on_top";
  /** Euros a month at the last 30 days of use; null with no history for this job. */
  readonly monthly_eur: number | null;
  /** With no history: euros for an hour of audio (transcription). */
  readonly per_hour_eur: number | null;
  /** With no history: euros for 100 analysis calls. */
  readonly per_100_calls_eur: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** One line, pure over the volume and unit costs. */
export function costLine(provider: ProviderId, job: Job, volume: Volume, unit: UnitCost): CostLine {
  const billing = PROVIDERS[provider].billing === "included" ? "included" : "on_top";
  const used = job === "transcription" ? volume.audioSeconds > 0 : volume.calls > 0;
  let monthly: number | null = null;
  if (used) {
    if (job === "transcription")
      monthly = unit.perAudioSecond === null ? null : volume.audioSeconds * unit.perAudioSecond;
    else
      monthly =
        unit.perToken !== null && volume.tokens > 0
          ? volume.tokens * unit.perToken
          : unit.perCall === null
            ? null
            : volume.calls * unit.perCall;
  }
  const perHour = unit.perAudioSecond === null ? null : round2(unit.perAudioSecond * 3600);
  const per100 = unit.perCall === null ? null : round2(unit.perCall * 100);
  return {
    job,
    provider,
    billing,
    monthly_eur: monthly === null ? null : round2(monthly),
    per_hour_eur: used ? null : job === "transcription" ? perHour : null,
    per_100_calls_eur: used ? null : job === "analysis" ? per100 : null,
  };
}

/** The first instant of the calendar month `now` is in (UTC). */
export const monthStart = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/** Euros an account has spent per provider since the calendar month began. */
export async function monthSpend(
  db: Db,
  organisationId: string,
  now: Date,
): Promise<Record<ProviderId, number>> {
  const rows = await db.execute<{ provider: string; cost: number | null }>(sql`
    select ${PROVIDER_OF} as provider, sum(coalesce(cost_micro_eur, 0))::float8 as cost
    from model_call
    where started_at >= ${monthStart(now).toISOString()}::timestamptz
      and started_at <= ${now.toISOString()}::timestamptz
      and organisation_id = ${organisationId}::uuid and payer = 'account'
    group by 1`);
  const euros = (id: ProviderId) =>
    round2(Number(rows.find((r) => r.provider === id)?.cost ?? 0) / MICRO);
  return { scaleway: euros("scaleway"), google: euros("google") };
}

/**
 * What each account spent on Google over a period, in euros: the figure the invoice of
 * Google's usage will read. Nothing invoices it yet; this is the seam. The period is half open,
 * [from, until).
 */
export async function googleSpendByAccount(
  db: Db,
  period: { from: Date; until: Date },
): Promise<{ organisationId: string; euros: number }[]> {
  const rows = await db.execute<{ organisation_id: string; cost: number }>(sql`
    select organisation_id::text as organisation_id, sum(coalesce(cost_micro_eur, 0))::float8 as cost
    from model_call
    where started_at >= ${period.from.toISOString()}::timestamptz
      and started_at < ${period.until.toISOString()}::timestamptz
      and organisation_id is not null and payer = 'account'
      and ${PROVIDER_OF} = 'google'
    group by 1
    having sum(coalesce(cost_micro_eur, 0)) > 0
    order by 1`);
  return rows.map((r) => ({
    organisationId: r.organisation_id,
    euros: round2(Number(r.cost) / MICRO),
  }));
}
