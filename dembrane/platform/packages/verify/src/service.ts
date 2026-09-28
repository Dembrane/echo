import type { Policy } from "@dembrane/access";
import { type ConversationsDeps, PARTICIPANT_TOKEN_HEADER } from "@dembrane/conversations";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  newId,
  PlatformError,
} from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import { directusRow, isoTimestamp } from "@dembrane/legacy-shape";
import { renderPrompt } from "@dembrane/prompts";
import { type FilePart, generateText, type TextPart } from "ai";
import { type ArtifactRow, type VerifyStorage, verifyStorage } from "./storage";

export type VerifyDeps = Pick<
  ConversationsDeps,
  "db" | "access" | "audio" | "audioUrls" | "models" | "tokens" | "logger" | "now"
>;

/** 500 with the text the old API sent when the model call failed. */
class GenerationError extends PlatformError {
  readonly status = 500;
  readonly code = "generation_failed";
}

export interface TopicView {
  key: string;
  prompt: string | null;
  icon: string | null;
  sort: number | null;
  is_custom: boolean;
  translations: Record<string, { label: string }>;
}

interface Ctx {
  readonly d: VerifyDeps;
  readonly store: VerifyStorage;
}

export function verifyContext(d: VerifyDeps): Ctx {
  return { d, store: verifyStorage(d.db) };
}

const iso = (v: string | null | undefined) => isoTimestamp(v ?? null);

// ── topics ────────────────────────────────────────────────────────────

/** Defaults by (sort, key), then the project's own topics oldest first. */
async function topicsFor(ctx: Ctx, projectId: string): Promise<TopicView[]> {
  const rows = await ctx.store.topics(projectId);
  const views = rows.map(({ topic, translations }) => {
    const map: Record<string, { label: string }> = {};
    for (const t of translations)
      if (t.languages_code && t.label) map[t.languages_code] = { label: t.label };
    return {
      view: {
        key: topic.key,
        prompt: topic.prompt,
        icon: topic.icon,
        sort: topic.sort,
        is_custom: topic.project_id !== null,
        translations: map,
      } satisfies TopicView,
      created: iso(topic.date_created) ?? "",
    };
  });
  const defaults = views
    .filter((v) => !v.view.is_custom)
    .sort((a, b) => (a.view.sort ?? 0) - (b.view.sort ?? 0) || cmp(a.view.key, b.view.key));
  const customs = views.filter((v) => v.view.is_custom).sort((a, b) => cmp(a.created, b.created));
  return [...defaults, ...customs].map((v) => v.view);
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The stored selection limited to topics that exist; nothing valid selected means all of them. */
function selected(raw: string | null, topics: TopicView[]): string[] {
  const keys = new Set(topics.map((t) => t.key).filter(Boolean));
  const picked = (raw ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k && keys.has(k));
  return picked.length ? picked : topics.map((t) => t.key).filter(Boolean);
}

async function projectOr404(ctx: Ctx, projectId: string) {
  const project = await ctx.store.project(projectId);
  if (!project) throw new NotFoundError("Project not found");
  return project;
}

async function topicsResponse(ctx: Ctx, projectId: string) {
  const project = await projectOr404(ctx, projectId);
  const topics = await topicsFor(ctx, projectId);
  return {
    selected_topics: selected(project.selected_verification_key_list, topics),
    available_topics: topics,
  };
}

export function getTopics(ctx: Ctx, projectId: string) {
  return topicsResponse(ctx, projectId);
}

/**
 * The host's gate on topic settings. The Python API admitted any role on the project
 * (and PUT /topics nobody at all, H-1); the intent is project:update (M-1). Refusals
 * keep the old text. Staff act through their own workspace role (H-14).
 */
async function requireUpdate(ctx: Ctx, who: Signed, projectId: string) {
  if (!who.appUserId) throw new ForbiddenError("Not authorized for this project");
  const policy: Policy = "project:update";
  try {
    await ctx.d.access.project(who, projectId, policy);
  } catch (err) {
    if (err instanceof NotFoundError || err instanceof ForbiddenError)
      throw new ForbiddenError("Not authorized for this project");
    throw err;
  }
}

/** _slugify: word characters, spaces and dashes; runs of space or underscore become one dash. */
export function slugify(text: string): string {
  const s = text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}_\s-]/gu, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s ? [...s].slice(0, 60).join("") : "custom";
}

export async function createCustomTopic(
  ctx: Ctx,
  who: Signed,
  projectId: string,
  body: {
    label: string;
    prompt: string;
    icon: string | null;
    translations: Record<string, string>;
  },
) {
  const project = await projectOr404(ctx, projectId);
  await requireUpdate(ctx, who, projectId);
  const key = `${slugify(body.label)}-${newId().replace(/-/g, "").slice(-8)}`;
  const labels = [{ languages_code: "en-US", label: body.label }];
  for (const [code, label] of Object.entries(body.translations))
    if (code !== "en-US" && label?.trim())
      labels.push({ languages_code: code, label: label.trim() });
  await ctx.store.createTopic(
    { key, prompt: body.prompt, icon: body.icon || null, projectId, userId: who.directusUserId },
    labels,
    ctx.d.now(),
  );
  const existing = project.selected_verification_key_list;
  if (existing) {
    const list = existing
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    if (!list.includes(key)) list.push(key);
    await ctx.store.setSelected(projectId, list.join(","), ctx.d.now());
  }
  return topicsResponse(ctx, projectId);
}

export async function updateCustomTopic(
  ctx: Ctx,
  who: Signed,
  projectId: string,
  key: string,
  body: {
    label: string | null;
    prompt: string | null;
    icon: string | null;
    translations: Record<string, string> | null;
  },
) {
  await projectOr404(ctx, projectId);
  await requireUpdate(ctx, who, projectId);
  const found = await ctx.store.customTopic(projectId, key);
  if (!found) throw new NotFoundError("Custom topic not found for this project");
  const fields: { prompt?: string; icon?: string | null } = {};
  if (body.prompt !== null) fields.prompt = body.prompt;
  if (body.icon !== null) fields.icon = body.icon || null;
  const updates: { id: number; label: string }[] = [];
  const creates: { languages_code: string; label: string }[] = [];
  // As before, a new label only lands when translations are sent too.
  if (body.translations !== null) {
    const byLang = new Map<string, number>();
    for (const t of found.translations)
      if (t.languages_code && t.id) byLang.set(t.languages_code, t.id);
    const merged = { ...body.translations };
    if (body.label !== null) merged["en-US"] = body.label;
    for (const [code, label] of Object.entries(merged)) {
      const id = byLang.get(code);
      if (id !== undefined) updates.push({ id, label: label ? label.trim() : "" });
      else if (label?.trim()) creates.push({ languages_code: code, label: label.trim() });
    }
  }
  if (Object.keys(fields).length || updates.length || creates.length)
    await ctx.store.updateTopic(key, fields, updates, creates, who.directusUserId, ctx.d.now());
  return topicsResponse(ctx, projectId);
}

export async function deleteCustomTopic(ctx: Ctx, who: Signed, projectId: string, key: string) {
  const project = await projectOr404(ctx, projectId);
  await requireUpdate(ctx, who, projectId);
  if (!(await ctx.store.customTopic(projectId, key)))
    throw new NotFoundError("Custom topic not found for this project");
  await ctx.store.deleteTopic(key);
  const existing = project.selected_verification_key_list ?? "";
  const list = existing
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k && k !== key);
  await ctx.store.setSelected(projectId, list.join(",") || null, ctx.d.now());
  return topicsResponse(ctx, projectId);
}

// ── artifacts ─────────────────────────────────────────────────────────

function artifactView(a: ArtifactRow, fallbackConversation: string) {
  const r = directusRow(a);
  return {
    id: a.id,
    key: a.key,
    topic_label: a.topic_label,
    content: a.content || "",
    conversation_id: a.conversation_id || fallbackConversation,
    approved_at: (r.approved_at as string | null) ?? null,
    date_created: (r.date_created as string | null) ?? null,
    read_aloud_stream_url: a.read_aloud_stream_url || "",
  };
}

/**
 * The portal's capability on a conversation (Q7): a participant token, when sent, must
 * name it; without one the conversation id still works unless tokens are required.
 */
function checkToken(ctx: Ctx, header: string | undefined, conversationId: string) {
  ctx.d.tokens.check(header, conversationId);
}

export async function listArtifacts(ctx: Ctx, conversationId: string, token: string | undefined) {
  const row = await ctx.store.conversation(conversationId);
  if (!row) throw new NotFoundError("Conversation not found");
  checkToken(ctx, token, conversationId);
  const approved = (await ctx.store.artifacts(conversationId)).filter((a) => a.approved_at);
  // Newest approval first, compared as the timestamps Directus printed.
  approved.sort((a, b) => cmp(iso(b.approved_at) ?? "", iso(a.approved_at) ?? ""));
  return approved.map((a) => {
    const v = artifactView(a, conversationId);
    // The list read no conversation_id; the path's id stood in.
    return { ...v, conversation_id: conversationId };
  });
}

export async function getArtifact(ctx: Ctx, artifactId: string, token: string | undefined) {
  if (!artifactId.trim()) throw new BadRequestError("The artifact_id field is required.");
  const a = await ctx.store.artifact(artifactId);
  if (!a) throw new NotFoundError("Artifact not found");
  if (a.conversation_id) checkToken(ctx, token, a.conversation_id);
  const v = artifactView(a, "");
  return {
    id: v.id,
    key: a.key || "",
    topic_label: v.topic_label,
    content: v.content,
    date_created: v.date_created,
    approved_at: v.approved_at,
    read_aloud_stream_url: v.read_aloud_stream_url,
  };
}

/**
 * The conversation a verify write acts on (H-2): it must exist and not be deleted, its
 * project too, and the project must have verify switched on. The Python API checked
 * none of these.
 */
async function verifiableConversation(ctx: Ctx, conversationId: string, token: string | undefined) {
  const row = await ctx.store.conversation(conversationId);
  if (!row || row.conversation.deleted_at || !row.project || row.project.deleted_at)
    throw new NotFoundError("Conversation not found");
  checkToken(ctx, token, conversationId);
  if (!row.project.is_verify_enabled)
    throw new ForbiddenError("Verify is not enabled for this project");
  return row;
}

/** Python's datetime.isoformat() of a Directus timestamp: microseconds only when present. */
export function pyIsoformat(v: string | null): string {
  if (!v) return "unknown";
  const d = new Date(isoTimestamp(v) ?? v);
  const ms = d.getUTCMilliseconds();
  return d
    .toISOString()
    .replace(/\.\d{3}Z$/, ms ? `.${String(ms).padStart(3, "0")}000+00:00` : "+00:00");
}

type Chunk = Awaited<ReturnType<VerifyStorage["chunks"]>>[number];
const time = (v: string | null) => (v ? new Date(isoTimestamp(v) ?? v).getTime() : null);

function transcriptText(chunks: Chunk[]): string {
  return chunks
    .map((c) => (c.transcript ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

/** Chunks with audio but no transcript after the reference time: sent to the model as sound. */
function audioChunks(chunks: Chunk[], after: number | null): Chunk[] {
  return chunks.filter((c) => {
    if ((c.transcript ?? "").trim()) return false;
    const t = time(c.timestamp);
    if (after !== null && t !== null && t <= after) return false;
    return Boolean(c.path);
  });
}

async function audioParts(ctx: Ctx, chunks: Chunk[]) {
  const out: (TextPart | FilePart)[] = [];
  for (const c of chunks) {
    out.push({ type: "text", text: `Audio chunk ${c.id} captured at ${pyIsoformat(c.timestamp)}` });
    if (!c.path) continue;
    try {
      const blob = await ctx.d.audio.get(ctx.d.audioUrls.keyOf(c.path));
      if (!blob) throw new Error("audio object missing");
      // Labelled audio/mp3 whatever the container, as the Python API sent it.
      out.push({
        type: "file",
        data: new Uint8Array(await blob.arrayBuffer()),
        mediaType: "audio/mp3",
      });
    } catch (err) {
      ctx.d.logger.warn({ err, chunk: c.id }, "failed to attach audio chunk");
    }
  }
  return out;
}

async function complete(
  ctx: Ctx,
  system: string,
  content: (TextPart | FilePart)[],
  failure: string,
) {
  try {
    const { text } = await generateText({
      model: ctx.d.models.model("multi_modal_pro"),
      system,
      messages: [{ role: "user", content }],
      providerOptions: { vertex: { thinkingConfig: { thinkingBudget: 2048 } } },
    });
    return text;
  } catch (err) {
    ctx.d.logger.error({ err }, "verify completion failed");
    throw new GenerationError(failure);
  }
}

export async function generateArtifact(
  ctx: Ctx,
  body: { topic_list: string[]; conversation_id: string },
  token: string | undefined,
) {
  const row = await verifiableConversation(ctx, body.conversation_id, token);
  const project = row.project as NonNullable<typeof row.project>;
  const conv = row.conversation;
  const anonymized = Boolean(project.anonymize_transcripts);
  const topics = await topicsFor(ctx, project.id);
  const targetKey = body.topic_list[0] ?? "";
  const target = topics.find((t) => t.key === targetKey);
  if (!target?.prompt) throw new BadRequestError(`Verification topic '${targetKey}' not found`);

  const artifacts = await ctx.store.artifacts(conv.id);
  const last = artifacts.at(-1);
  const lastTime = last ? time(last.date_created) : null;
  const chunks = await ctx.store.chunks(conv.id);
  if (!chunks.length) {
    ctx.d.logger.error({ conversation: conv.id }, "verify blocked: conversation has no chunks yet");
    throw new BadRequestError("Conversation has no chunks yet", {
      code: "NO_CHUNKS",
      message: "Conversation has no chunks yet",
    });
  }
  const audio = audioChunks(chunks, lastTime);
  const previous = artifacts.length
    ? [
        "Previous artifacts:",
        ...artifacts.map(
          (a) =>
            `- [${iso(a.date_created) ?? "unknown"}] (${a.key || "unknown key"}) ${a.content ?? ""}`,
        ),
        "",
      ].join("\n")
    : "Previous artifacts: None\n";
  const lines = [`Project: ${project.name || project.id}`, `Conversation ID: ${conv.id}`];
  if (conv.participant_name) lines.push(`Participant name: ${conv.participant_name}`);
  if (conv.participant_email)
    lines.push(`Participant email: ${anonymized ? "<redacted_email>" : conv.participant_email}`);
  const transcript = transcriptText(chunks);
  lines.push(
    "",
    previous,
    "Conversation transcript:",
    transcript || "No transcript available.",
    "",
    audio.length
      ? [
          "Audio attachments for chunks without transcripts after the last artifact:",
          ...audio.map((c) => `- chunk_id=${c.id} timestamp=${pyIsoformat(c.timestamp)}`),
        ].join("\n")
      : "Audio attachments: None.",
  );
  const system = renderPrompt("generate_artifact", "en", {
    prompt: target.prompt,
    language: project.language || "en",
    pii_redaction: anonymized,
  });
  const text = await complete(
    ctx,
    system,
    [{ type: "text", text: lines.join("\n") }, ...(await audioParts(ctx, audio))],
    "Failed to generate verification artifact",
  );
  const created = await ctx.store.createArtifact({
    id: newId(),
    conversationId: conv.id,
    key: targetKey,
    topicLabel: target.translations["en-US"]?.label || targetKey,
    content: text,
    now: ctx.d.now(),
  });
  return { artifact_list: [artifactView(created, conv.id)] };
}

export async function updateArtifact(
  ctx: Ctx,
  artifactId: string,
  body: {
    useConversation: { conversationId: string; timestamp: Date } | null;
    content: string | null;
    approvedAt: string | null;
  },
  token: string | undefined,
) {
  if (!body.useConversation && body.content === null)
    throw new BadRequestError("No updates provided");
  if (body.useConversation && body.content !== null)
    throw new BadRequestError("Provide either useConversation or content, not both");
  const artifact = await ctx.store.artifact(artifactId);
  if (!artifact) throw new NotFoundError("Artifact not found");
  // H-2: the artifact's own conversation is the one that must be open for verify.
  if (!artifact.conversation_id) throw new NotFoundError("Conversation not found");
  const row = await verifiableConversation(ctx, artifact.conversation_id, token);
  const updates: { content?: string; approved_at?: string } = {};
  if (body.approvedAt !== null) updates.approved_at = body.approvedAt;
  if (body.useConversation) {
    // H-2: revising could pull another conversation's transcript into this artifact.
    if (body.useConversation.conversationId !== artifact.conversation_id)
      throw new BadRequestError("The artifact does not belong to this conversation");
    const project = row.project as NonNullable<typeof row.project>;
    const anonymized = Boolean(project.anonymize_transcripts);
    const chunks = await ctx.store.chunks(artifact.conversation_id);
    const ref = body.useConversation.timestamp.getTime();
    const feedback = chunks
      .filter((c) => {
        const t = time(c.timestamp);
        return t !== null && t > ref && (c.transcript ?? "").trim();
      })
      .map((c) => `[${pyIsoformat(c.timestamp)}] ${(c.transcript ?? "").trim()}`)
      .join("\n");
    const audio = audioChunks(chunks, ref);
    if (!feedback && !audio.length)
      throw new BadRequestError("No new feedback found since provided timestamp", {
        code: "NO_NEW_FEEDBACK",
        message: "No new feedback found since provided timestamp",
      });
    const system = renderPrompt("revise_artifact", "en", {
      transcript: transcriptText(chunks) || "No transcript available.",
      outcome: artifact.content || "",
      feedback: feedback || "No textual feedback available.",
      language: project.language || "en",
      pii_redaction: anonymized,
    });
    updates.content = await complete(
      ctx,
      system,
      [
        {
          type: "text",
          text: "Please revise the outcome using the feedback provided. Audio clips accompany segments without transcripts.",
        },
        ...(await audioParts(ctx, audio)),
      ],
      "Failed to revise verification artifact",
    );
  } else if (body.content !== null) updates.content = body.content;
  if (!Object.keys(updates).length) throw new BadRequestError("No valid fields to update");
  const updated = (await ctx.store.updateArtifact(artifactId, updates)) ?? artifact;
  const v = artifactView(updated, artifact.conversation_id);
  return {
    ...v,
    topic_label: updated.topic_label || artifact.topic_label,
    content: updated.content || updates.content || artifact.content || "",
  };
}

export { PARTICIPANT_TOKEN_HEADER };
