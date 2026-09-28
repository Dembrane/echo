import { ForbiddenError, NotFoundError, ValidationError } from "@dembrane/core";
import type { Db } from "@dembrane/db";
import { dict, isRecord, type Json, list, pyIso, pyStr, strip } from "./py";
import { tokenUrlsafe, uuid5Url } from "./service";
import { client, isUuid, j, type Row, type Sql } from "./storage";

/**
 * Synthetic demos, seeded by staff: the write echo/demos/seed_demo.py made through
 * Directus /items, made here once Directus is gone. One synthetic project per language in
 * the demo's session, each with the invented conversations, a popcorn session in manual
 * mode carrying the reviewed read and the synthetic marking, plus the sales portal
 * projects the QR opens. Every id is the seed's deterministic one, so a rerun updates that
 * demo and nothing else, and the old and new paths write the same rows.
 */

/** The hosts the seed refuses: production waits for the MCP upsert. */
export const PRODUCTION_HOSTS = new Set([
  "directus.dembrane.com",
  "api.dembrane.com",
  "dashboard.dembrane.com",
]);
export const PRODUCTION_REFUSAL =
  "This seed is for a staging environment; production waits for the MCP upsert.";

const PARTICIPANT_CODES: Readonly<Record<string, string>> = {
  en: "en-US",
  es: "es-ES",
  nl: "nl-NL",
};
const SUMMARY: Readonly<Record<string, string>> = {
  en: "Synthetic demo. An invented conversation. No real participants.",
  es: "Demo sintética. Una conversación inventada. Sin participantes reales.",
  nl: "Synthetische demo. Een verzonnen gesprek. Geen echte deelnemers.",
};

export interface DemoCorpusEntry {
  readonly id: string;
  readonly label: string;
  readonly start: string;
  readonly chunks: readonly string[];
}

export interface DemoInput {
  /** The demo's session.json. */
  readonly session: Json;
  /** research.md: becomes each project's context and the popcorn brief. */
  readonly research: string;
  /** corpus/NN-*.json in file-name order. */
  readonly corpus: readonly DemoCorpusEntry[];
  /** out/state-<lang>.json and out/settings-<lang>.json per language. */
  readonly out: Readonly<Record<string, { state: Json; settings: Json }>>;
  /** echo/demos/sales-portal.json: the words of the portal the QR opens, per language. */
  readonly salesPortal: Readonly<Record<string, Json>>;
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly portalBaseUrl: string;
  readonly apiBaseUrl: string;
  readonly dryRun: boolean;
  /**
   * For a prospect's demo: where "Continue in dembrane" on the public page leads (the
   * dashboard sign-in). Absent, the deck is exactly what the seed made before.
   */
  readonly continueUrl?: string;
}

/** The seed's identity(): the namespace the local helper shares, so sales portals converge. */
export function demoIdentity(slug: string, kind: string): string {
  return uuid5Url(`dembrane:synthetic-demo:${slug}:${kind}`);
}

/** urllib.parse.quote_plus: letters, digits and _.-~ stay; spaces become +. */
function quotePlus(s: string): string {
  return [...new TextEncoder().encode(s)]
    .map((b) => {
      const ch = String.fromCharCode(b);
      if (/[A-Za-z0-9_.\-~]/.test(ch)) return ch;
      if (ch === " ") return "+";
      return `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
}

function portalStart(base: string, projectId: string, language: string, slug: string): string {
  const code = PARTICIPANT_CODES[language] as string;
  const query = `utm_source=popcorn_demo&utm_campaign=${quotePlus(slug)}`;
  return `${base.replace(/\/+$/, "")}/${code}/${projectId}/start?${query}`;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

/** Refuses production as the seed does, including this deployment's own address. */
export function refuseProduction(urls: readonly string[]): void {
  if (urls.some((u) => PRODUCTION_HOSTS.has(hostOf(u))))
    throw new ForbiddenError(PRODUCTION_REFUSAL);
}

/** Python's datetime.fromisoformat(start) + timedelta(seconds), then isoformat(). */
export function chunkTimestamp(start: string, seconds: number): string {
  const m =
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(
      start,
    );
  if (!m) throw new ValidationError(`Invalid isoformat string: '${start}'`);
  const [, date, hh, mm, ss = "00", frac = "", zone] = m;
  const micros = Number(frac.padEnd(6, "0") || "0");
  const base = Date.UTC(
    Number(date?.slice(0, 4)),
    Number(date?.slice(5, 7)) - 1,
    Number(date?.slice(8, 10)),
    Number(hh),
    Number(mm),
    Number(ss),
  );
  const t = new Date(base + seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const wall = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`;
  const us = micros ? `.${String(micros).padStart(6, "0")}` : "";
  let offset = "";
  if (zone)
    offset =
      zone === "Z" ? "+00:00" : zone.includes(":") ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  return `${wall}${us}${offset}`;
}

/** The reviewed read with its conversation ids moved to this language's conversations. */
function remapped(state: Json, language: string, corpus: readonly DemoCorpusEntry[], slug: string) {
  let text = JSON.stringify(state);
  for (const conv of corpus)
    text = text.replaceAll(
      demoIdentity(slug, conv.id),
      demoIdentity(slug, `${language}:${conv.id}`),
    );
  return JSON.parse(text) as Json;
}

// Directus stamped these on create and on update; the seed never sent them.
const CREATED: Readonly<Record<string, string>> = {
  project: "created_at",
  conversation: "created_at",
  conversation_chunk: "created_at",
  project_report: "date_created",
  canvas_config_revision: "created_at",
  agent_loop: "created_at",
};
const UPDATED: Readonly<Record<string, string>> = {
  project: "updated_at",
  conversation: "updated_at",
  conversation_chunk: "updated_at",
  project_report: "date_updated",
  agent_loop: "updated_at",
};
const JSON_FIELDS = new Set(["gather_spec", "popcorn_settings", "caps", "popcorn_state"]);

/**
 * Directus's upsert as the seed ran it: read by id, then patch the given fields or insert
 * the row with that id, stamping the fields Directus filled itself.
 */
async function upsert(
  tx: Sql,
  collection: string,
  id: string | number,
  payload: Json,
  now: string,
) {
  const [existing] = await tx`select id from ${tx(collection)} where id = ${id}`;
  const values: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) values[k] = JSON_FIELDS.has(k) ? j(v) : v;
  if (existing) {
    const stamp = UPDATED[collection];
    if (stamp) values[stamp] = now;
    const [row] = await tx`update ${tx(collection)} set ${tx(values as Record<string, never>)}
      where id = ${id} returning *`;
    return row as Row;
  }
  const stamp = CREATED[collection];
  if (stamp) values[stamp] = now;
  values.id = id;
  const [row] =
    await tx`insert into ${tx(collection)} ${tx(values as Record<string, never>)} returning *`;
  return row as Row;
}

async function insert(tx: Sql, collection: string, payload: Json, now: string) {
  const values: Record<string, unknown> = { ...payload };
  const stamp = CREATED[collection];
  if (stamp) values[stamp] = now;
  const [row] =
    await tx`insert into ${tx(collection)} ${tx(values as Record<string, never>)} returning *`;
  return row as Row;
}

export interface DemoResult {
  readonly result: Json;
  /** What the seed's --dry-run printed: one create or update line per row. */
  readonly plan: readonly string[];
}

class DryRun extends Error {
  constructor(readonly outcome: DemoResult) {
    super("dry run");
  }
}

function check(input: DemoInput, languages: readonly string[]) {
  for (const language of languages) {
    if (!(language in PARTICIPANT_CODES))
      throw new ValidationError(`No participant portal language for '${language}'`);
    if (!isRecord(input.out[language]?.state) || !isRecord(input.out[language]?.settings))
      throw new ValidationError(
        `out/state-${language}.json and out/settings-${language}.json are needed`,
      );
    if (!isRecord(input.salesPortal[language]))
      throw new ValidationError(`sales-portal.json has no '${language}' words`);
  }
}

/**
 * Seeds one demo. Everything happens in one transaction, so a failure leaves nothing half
 * written; a dry run plans the same writes and rolls them back.
 */
export async function seedDemo(db: Db, input: DemoInput, now: Date): Promise<DemoResult> {
  const session = input.session;
  const slug = pyStr(session.slug);
  const languages = Object.keys(dict(session.title));
  check(input, languages);
  if (!isUuid(input.workspaceId)) throw new NotFoundError("Workspace not found");
  const sql = client(db);
  const nowIso = pyIso(now);
  const plan: string[] = [];
  try {
    return (await sql.begin(async (tx) => {
      const [ws] =
        await tx`select id from workspace where id = ${input.workspaceId} and deleted_at is null`;
      if (!ws) throw new NotFoundError("Workspace not found");
      const [owner] = isUuid(input.ownerId)
        ? await tx`select id from directus_users where id = ${input.ownerId}`
        : [];
      if (!owner) throw new NotFoundError("Owner not found");
      const put = async (collection: string, id: string | number, payload: Json) => {
        const [existing] = await tx`select id from ${tx(collection)} where id = ${id}`;
        plan.push(`${existing ? "update" : "create"} ${collection} ${id}`);
        return upsert(tx, collection, id, payload, nowIso);
      };

      const portals: Record<string, string> = {};
      for (const language of languages) {
        const pid = demoIdentity("sales-portal", language);
        await put("project", pid, {
          ...(input.salesPortal[language] as Json),
          language,
          workspace_id: input.workspaceId,
          directus_user_id: input.ownerId,
          is_conversation_allowed: true,
        });
        portals[language] = portalStart(input.portalBaseUrl, pid, language, slug);
      }
      const result: Json = { sales_portals: portals };
      for (const language of languages) {
        const out = input.out[language] as { state: Json; settings: Json };
        const state = remapped(out.state, language, input.corpus, slug);
        const demo = dict(state.demo);
        demo.portal_url = portals[language];
        demo.portal_urls = portals;
        if (input.continueUrl) demo.continue_url = input.continueUrl;
        state.demo = demo;
        const title = pyStr(dict(session.title)[language]);
        const pid = demoIdentity(slug, `project-${language}`);
        await put("project", pid, {
          name: `[SYNTHETIC] ${pyStr(session.organisation)} · ${title} (${language.toUpperCase()})`,
          language,
          workspace_id: input.workspaceId,
          directus_user_id: input.ownerId,
          is_canvas_enabled: true,
          is_conversation_allowed: false,
          anonymize_transcripts: true,
          context: input.research,
        });
        const summaries = dict(session.summary);
        const summary = pyStr(summaries[language] || SUMMARY[language] || SUMMARY.en);
        for (const conv of input.corpus) {
          const cid = demoIdentity(slug, `${language}:${conv.id}`);
          const chunks = conv.chunks.map((c) => strip(c)).filter(Boolean);
          await put("conversation", cid, {
            project_id: pid,
            participant_name: conv.label,
            title: conv.label,
            source: "DASHBOARD_UPLOAD",
            is_finished: true,
            is_all_chunks_transcribed: true,
            is_audio_processing_finished: true,
            merged_transcript: chunks.join("\n"),
            summary,
          });
          for (const [index, chunk] of chunks.entries())
            await put(
              "conversation_chunk",
              demoIdentity(slug, `${language}:${conv.id}:chunk:${String(index).padStart(3, "0")}`),
              {
                conversation_id: cid,
                transcript: chunk,
                timestamp: chunkTimestamp(conv.start, 20 * index),
              },
            );
        }
        const [found] = await tx`select id, public_token from project_report
          where project_id = ${pid} and kind = 'popcorn' order by id limit 1`;
        const reportData: Json = {
          project_id: pid,
          kind: "popcorn",
          status: "published",
          user_instructions: title,
          content: "",
          public_token: (found?.public_token as string | null) || tokenUrlsafe(),
          user_created: input.ownerId,
        };
        let report: Row;
        if (found) report = await put("project_report", String(found.id), reportData);
        else {
          plan.push("create project_report");
          report = await insert(tx, "project_report", reportData, nowIso);
        }
        const rid = String(report.id);
        await put("canvas_config_revision", demoIdentity(slug, `config-${language}`), {
          report_id: rid,
          brief: input.research,
          gather_spec: { full_history: true },
          popcorn_settings: out.settings,
          cadence_minutes: 2,
          created_by: input.ownerId,
          note: `Synthetic ${pyStr(session.organisation)} demo: read by the popcorn pipeline over invented transcripts.`,
        });
        await put("agent_loop", demoIdentity(slug, `loop-${language}`), {
          project_id: pid,
          report_id: rid,
          name: title,
          status: "paused",
          expires_at: nowIso,
          cadence_minutes: 2,
          acting_directus_user_id: input.ownerId,
          failure_count: 0,
          caps: { kind: "popcorn" },
          popcorn_state: state,
        });
        result[language] = {
          project_id: pid,
          report_id: rid,
          public_link: `${input.apiBaseUrl.replace(/\/+$/, "")}/api/v2/popcorn/public/${reportData.public_token}/`,
        };
      }
      const outcome = { result, plan };
      if (input.dryRun) throw new DryRun(outcome);
      return outcome;
    })) as DemoResult;
  } catch (err) {
    if (err instanceof DryRun) return err.outcome;
    throw err;
  }
}

/** The corpus entries as the seed reads them from the request. */
export function corpusFrom(raw: readonly unknown[]): DemoCorpusEntry[] {
  return raw.map((entry, i) => {
    const e = dict(entry);
    if (typeof e.id !== "string" || typeof e.label !== "string" || typeof e.start !== "string")
      throw new ValidationError(`corpus[${i}] needs id, label and start`);
    return {
      id: e.id,
      label: e.label,
      start: e.start,
      chunks: list(e.chunks).map((c) => pyStr(c)),
    };
  });
}
