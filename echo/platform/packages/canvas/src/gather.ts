import { type AccessStore, resolveProject } from "@echo/access";
import { directusTime, isRecord, type Json, orStr, pyStr, truthy, utcNowIso } from "./py";
import type { CanvasStore } from "./storage";

/** CANVAS_MAX_TRANSCRIPT_CHARS_PER_CONVERSATION and CANVAS_MAX_TOTAL_TRANSCRIPT_CHARS. */
export const MAX_CHARS_PER_CONVERSATION = 6_000;
export const MAX_TOTAL_CHARS = 28_000;

export const SAMPLE_CONVERSATIONS: readonly Json[] = [
  {
    id: "sample-conversation-1",
    label: "Sample participant 1",
    created_at: "sample",
    latest_transcript:
      "The welcome flow was clear, but I was not sure where to find the next step after leaving the session.",
  },
  {
    id: "sample-conversation-2",
    label: "Sample participant 2",
    created_at: "sample",
    latest_transcript:
      "I liked seeing the main themes quickly. I would trust it more if the page made it obvious which notes came from recent conversations.",
  },
  {
    id: "sample-conversation-3",
    label: "Sample participant 3",
    created_at: "sample",
    latest_transcript:
      "The most useful parts were concrete examples and a short list of things the team can act on this week.",
  },
  {
    id: "sample-conversation-4",
    label: "Sample participant 4",
    created_at: "sample",
    latest_transcript:
      "Some people are excited, but others need reassurance about privacy and what will happen with their feedback.",
  },
];

/** The acting user of a loop no longer reaches its project: the tick records an error. */
export class ReaderAccessDenied extends Error {}

export interface GatherDeps {
  readonly store: CanvasStore;
  readonly accessStore: AccessStore;
}

/**
 * The tick reads as the loop's acting user, not as the platform: a creator who lost
 * access to the project stops feeding the canvas. The Python helper raised the onboarding
 * HTTPException, whose text ("403: User not onboarded") is what a failed run recorded.
 */
export async function readerContext(d: GatherDeps, actingUser: string, projectId: string) {
  const [appUser] = await d.store
    .sql`select id from app_user where directus_user_id = ${actingUser}`;
  if (!appUser) throw new Error("403: User not onboarded");
  const project = await d.store.project(projectId);
  if (!project || project.deleted_at) throw new ReaderAccessDenied("Project not found");
  const access = await resolveProject(
    d.accessStore,
    projectId,
    { appUserId: String(appUser.id), directusUserId: actingUser },
    new Date(),
  );
  if (!access) throw new ReaderAccessDenied("Project access denied");
  return project;
}

function windowMinutes(spec: Json): number {
  const raw = spec.window_minutes ?? 60;
  let minutes = 60;
  if (typeof raw === "number" && Number.isFinite(raw)) minutes = Math.trunc(raw);
  else if (typeof raw === "boolean") minutes = Number(raw);
  else if (typeof raw === "string" && /^\s*[+-]?\d+\s*$/.test(raw))
    minutes = Number.parseInt(raw, 10);
  return Math.max(1, Math.min(minutes, 60 * 24 * 14));
}

function clip(text: string, limit: number): [string, boolean] {
  if (text.length <= limit) return [text, false];
  return [`${text.slice(0, limit).trimEnd()}\n[truncated]`, true];
}

/** Recent transcript data of a project, after verifying the acting user may read it. */
export async function executeGatherSpec(
  d: GatherDeps,
  args: {
    projectId: string;
    actingUser: string;
    gatherSpec: Json | null;
    previewSample?: boolean;
    fullHistory?: boolean;
    now?: Date;
  },
): Promise<Json> {
  const project = await readerContext(d, args.actingUser, args.projectId);
  const spec = args.gatherSpec ?? {};
  const minutes = windowMinutes(spec);
  const now = args.now ?? new Date();
  const since = new Date(now.getTime() - minutes * 60_000);
  const projectContext = {
    id: args.projectId,
    workspace_id: project.workspace_id ?? null,
    name: project.name ?? null,
    context: project.context ?? null,
    goal: await d.store.goalContent(args.projectId),
    language: truthy(project.language) ? project.language : "en",
    anonymize_transcripts: truthy(project.anonymize_transcripts),
  };
  const conversationIds = (Array.isArray(spec.conversation_ids) ? spec.conversation_ids : [])
    .filter(truthy)
    .map(pyStr);
  const tagIds = (Array.isArray(spec.tag_ids) ? spec.tag_ids : []).filter(truthy).map(pyStr);
  const conversations = await d.store.gatherConversations(args.projectId, conversationIds, tagIds);

  let remaining = MAX_TOTAL_CHARS;
  const out: Json[] = [];
  let latest: string | null = null;
  let chunksSeen = 0;
  let truncated = 0;
  for (const conv of conversations) {
    const convId = orStr(conv.id);
    if (!convId || remaining <= 0) break;
    const chunks = await d.store.gatherChunks(convId, args.fullHistory ? null : utcNowIso(since));
    const parts: string[] = [];
    const rows: Json[] = [];
    for (const chunk of chunks) {
      const transcript = orStr(chunk.transcript).trim();
      if (!transcript) continue;
      chunksSeen++;
      parts.push(transcript);
      const createdAt = directusTime(chunk.created_at);
      const timestamp = directusTime(chunk.timestamp);
      rows.push({ id: orStr(chunk.id) || null, transcript, created_at: createdAt, timestamp });
      const t = createdAt || timestamp;
      if (t && (latest === null || t > latest)) latest = t;
    }
    const joined = parts.join("\n").trim();
    if (!joined) continue;
    const [clipped, was] = clip(joined, Math.min(MAX_CHARS_PER_CONVERSATION, remaining));
    if (was) truncated++;
    remaining -= clipped.length;
    out.push({
      id: convId,
      label: truthy(conv.participant_name) ? conv.participant_name : "participant",
      created_at: directusTime(conv.created_at),
      latest_transcript: clipped,
      chunks: rows,
    });
  }
  const sampleMode = Boolean(args.previewSample && out.length < 2);
  const conversationsOut = sampleMode ? SAMPLE_CONVERSATIONS.map((c) => ({ ...c })) : out;
  return {
    spec: {
      version: 1,
      window_minutes: minutes,
      tag_ids: tagIds,
      conversation_ids: conversationIds,
      preview_sample: sampleMode,
      full_history: Boolean(args.fullHistory),
    },
    project: projectContext,
    counts: {
      conversations_considered: conversations.length,
      conversations_with_recent_content: out.length,
      sample_conversations_used: sampleMode ? conversationsOut.length : 0,
      chunks_seen: chunksSeen,
      truncated_conversations: truncated,
      max_transcript_chars_per_conversation: MAX_CHARS_PER_CONVERSATION,
      max_total_transcript_chars: MAX_TOTAL_CHARS,
    },
    latest_content_at: latest,
    sample_mode: sampleMode,
    sample_notice: sampleMode
      ? "Sample conversations, your real conversations replace these."
      : null,
    conversations: conversationsOut,
  };
}

export function gatherHasTranscript(bundle: Json): boolean {
  for (const conv of Array.isArray(bundle.conversations) ? bundle.conversations : []) {
    if (!isRecord(conv)) continue;
    if (orStr(conv.latest_transcript).trim()) return true;
    for (const chunk of Array.isArray(conv.chunks) ? conv.chunks : [])
      if (isRecord(chunk) && orStr(chunk.transcript).trim()) return true;
  }
  return false;
}
