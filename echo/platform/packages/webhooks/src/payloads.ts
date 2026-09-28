import { directusRow, pythonIso } from "@dembrane/legacy-shape";

/** Events a project webhook can subscribe to. */
export const WEBHOOK_EVENTS = [
  "conversation.started",
  "conversation.transcribed",
  "conversation.summarized",
  "report.generated",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const isWebhookEvent = (e: string): e is WebhookEvent =>
  (WEBHOOK_EVENTS as readonly string[]).includes(e);

/** How the Python API printed the list in its 400 message. */
export const EVENTS_REPR = `[${WEBHOOK_EVENTS.map((e) => `'${e}'`).join(", ")}]`;

const LOCALES: Record<string, string> = {
  en: "en-US",
  nl: "nl-NL",
  de: "de-DE",
  fr: "fr-FR",
  es: "es-ES",
  it: "it-IT",
  uk: "uk-UA",
  cs: "cs-CZ",
};

interface ProjectBits {
  id: string;
  name: string | null;
  language: string | null;
  workspace_id: string | null;
}

function projectData(p: ProjectBits) {
  return { id: p.id, name: p.name, language: p.language };
}

function dashboard(base: string, p: ProjectBits, tail: string) {
  const locale = LOCALES[p.language || "en"] ?? "en-US";
  return `${base.replace(/\/+$/, "")}/${locale}/w/${p.workspace_id}/projects/${p.id}/${tail}`;
}

export interface ConversationBits {
  id: string;
  created_at: unknown;
  updated_at: unknown;
  participant_name: unknown;
  duration: unknown;
  source: unknown;
  is_finished: unknown;
  is_all_chunks_transcribed: unknown;
  summary?: unknown;
  tags: { text: string | null }[];
}

/**
 * The conversation event body receivers parse. Transcribed and summarized events carry
 * the transcript; summarized also carries the summary.
 */
export function conversationPayload(
  event: string,
  conversation: ConversationBits,
  project: ProjectBits,
  opts: { transcript?: string; emailsCsv?: string; dashboardUrl: string; now: Date },
) {
  const c = conversation;
  const data: Record<string, unknown> = {
    id: conversation.id,
    created_at: c.created_at ?? null,
    updated_at: c.updated_at ?? null,
    participant_name: c.participant_name ?? null,
    duration: c.duration ?? null,
    source: c.source ?? null,
    is_finished: c.is_finished ?? null,
    is_all_chunks_transcribed: c.is_all_chunks_transcribed ?? null,
    tags: conversation.tags.map((t) => t.text).filter((t): t is string => Boolean(t)),
    emails_csv: opts.emailsCsv || "",
  };
  if (event === "conversation.transcribed" || event === "conversation.summarized")
    data.transcript = opts.transcript || "";
  if (event === "conversation.summarized") data.summary = conversation.summary || "";
  return {
    event,
    timestamp: pythonIso(opts.now),
    conversation: data,
    project: projectData(project),
    dashboardUrl: dashboard(
      opts.dashboardUrl,
      project,
      `conversations/${conversation.id}/overview`,
    ),
  };
}

export function reportPayload(
  event: string,
  report: { id: unknown; status: unknown; language: unknown; date_created: unknown },
  project: ProjectBits,
  opts: { dashboardUrl: string; now: Date },
) {
  const r = directusRow(report as Record<string, unknown>);
  return {
    event,
    timestamp: pythonIso(opts.now),
    report: {
      id: r.id ?? null,
      status: r.status ?? null,
      language: r.language ?? null,
      date_created: r.date_created ?? null,
    },
    project: projectData(project),
    dashboardUrl: dashboard(opts.dashboardUrl, project, "report"),
  };
}
