import type { Access } from "@dembrane/access";
import { BadRequestError, ConflictError, NotFoundError, newId } from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import { agentProject } from "../access";
import { buildCanvasHistory } from "./history";
import {
  appendHostItem,
  CanvasValueError,
  freshCanvasState,
  hostItem,
  normalizeCanvasTabs,
  type Obj,
  removeHostItem,
  statePatch,
} from "./ledgers";
import { sanitizeCanvasHtml } from "./sanitize";
import type { CanvasStorage } from "./storage";

export type CanvasStore = Omit<CanvasStorage, "sql">;

export interface CanvasDeps {
  readonly store: CanvasStore;
  readonly access: Access;
  /** ENABLE_CANVAS: the global half of the canvas gate. */
  readonly enableCanvas: boolean;
  readonly now: () => Date;
  /** Tells open canvas pages a new generation exists; best effort. */
  readonly publishGeneration: (reportId: string) => Promise<void>;
}

const DEFAULT_CADENCE_MINUTES = 5;
const TASK_CANVAS_TICK = "canvas_tick";
export const LOOP_ACTIONS = ["pause", "resume", "stop"] as const;
export type LoopAction = (typeof LOOP_ACTIONS)[number];

const s = (v: unknown): string | null => {
  if (v === null || v === undefined || typeof v === "object") return null;
  const t = String(v).trim();
  return t || null;
};
const relatedId = (v: unknown) => s(v && typeof v === "object" ? (v as Obj).id : v);

/**
 * The canvas beta gate: 404 "Not found" unless canvas is on globally and the project
 * opted in. Routes check it before authentication, as the FastAPI dependency ran first.
 */
export async function requireCanvasEnabled(d: CanvasDeps, projectId: string) {
  if (!d.enableCanvas || !(await d.store.projectFlag(projectId)))
    throw new NotFoundError("Not found");
}

async function gate(d: CanvasDeps, who: Signed, projectId: string) {
  await requireCanvasEnabled(d, projectId);
  await agentProject(d.access, who, projectId);
}

async function canvasOr404(d: CanvasDeps, projectId: string, canvasId: string): Promise<Obj> {
  const report = await d.store.report(canvasId);
  if (
    report?.kind !== "canvas" ||
    relatedId(report.project_id) !== projectId ||
    (report.deleted_at ?? null) !== null
  )
    throw new NotFoundError("Canvas not found");
  return report;
}

async function chatOr404(d: CanvasDeps, who: Signed, projectId: string, chatId: string) {
  const chat = await d.store.chat(chatId);
  if (!chat || relatedId(chat.project_id) !== projectId || (chat.deleted_at ?? null) !== null)
    throw new NotFoundError("Chat not found");
  if (chat.is_private && chat.user_created !== who.directusUserId)
    throw new NotFoundError("Chat not found");
}

const loopPayload = (loop: Obj) => ({
  status: loop.status ?? null,
  expires_at: loop.expires_at ?? null,
  cadence_minutes: loop.cadence_minutes ?? null,
});

const displayName = (loop: Obj | null, report: Obj) =>
  (loop?.name || report.user_instructions || "Canvas") as string;

async function enqueueTick(d: CanvasDeps, loopId: string, tickKind = "scheduled") {
  const at = d.now().toISOString();
  await d.store.scheduleTask({
    id: newId(),
    taskType: TASK_CANVAS_TICK,
    payload: { loop_id: loopId, tick_kind: tickKind },
    at,
    now: at,
  });
}

/** A ledger or sanitiser refusal is the host's input problem: 400 with its text. */
async function asBadRequest<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CanvasValueError) throw new BadRequestError(err.message);
    throw err;
  }
}

// ── reads ───────────────────────────────────────────────────────────────

export async function listCanvasSummaries(d: CanvasDeps, projectId: string) {
  const out: Obj[] = [];
  for (const report of await d.store.canvasReports(projectId)) {
    const reportId = String(report.id);
    const loop = await d.store.loopForReport(reportId);
    const run = loop ? await d.store.latestLoopRun(String(loop.id)) : null;
    const [generation] = await d.store.generations(reportId, 1);
    out.push({
      id: reportId,
      name: displayName(loop, report),
      kind: "canvas",
      created_at: report.date_created ?? null,
      latest_generation_at: generation?.created_at ?? null,
      updated_at: loop?.updated_at ?? null,
      loop: loop
        ? {
            ...loopPayload(loop),
            last_run_started_at: run?.started_at ?? null,
            last_run_status: run?.status ?? null,
            last_run_detail: run?.detail ?? null,
          }
        : null,
    });
  }
  return out;
}

/** GET /agentic/projects/{p}/canvases */
export async function canvases(
  d: CanvasDeps,
  who: Signed,
  projectId: string,
  _chatId: null | string,
) {
  await gate(d, who, projectId);
  return listCanvasSummaries(d, projectId);
}

/** GET /agentic/projects/{p}/chats/{chat}/canvas-activity */
export async function canvasActivity(
  d: CanvasDeps,
  who: Signed,
  projectId: string,
  chatId: string | null,
  limit: number,
) {
  await gate(d, who, projectId);
  await chatOr404(d, who, projectId, chatId ?? "");
  const runLimit = Math.min(limit, 10);
  const loops = await d.store.projectLoops(projectId);
  const reportIds = loops.map((l) => relatedId(l.report_id)).filter((x): x is string => !!x);
  const names = new Map<string, string>();
  for (const r of await d.store.reportInstructions(reportIds)) {
    const id = s(r.id);
    const name = s(r.user_instructions);
    if (id && name) names.set(id, name);
  }
  const out: Obj[] = [];
  for (const loop of loops) {
    const loopId = s(loop.id);
    if (!loopId) continue;
    const reportId = relatedId(loop.report_id);
    out.push({
      id: reportId ?? loopId,
      name: s(loop.name) ?? (reportId ? names.get(reportId) : undefined) ?? "Canvas",
      recent_runs: (await d.store.recentLoopRuns(loopId, runLimit)).map((r) => ({
        status: r.status ?? null,
        detail: r.detail ?? null,
        started_at: r.started_at ?? null,
      })),
    });
  }
  return { canvases: out };
}

/** GET /agentic/projects/{p}/canvases/{id} */
export async function canvas(
  d: CanvasDeps,
  who: Signed,
  projectId: string,
  _chatId: string | null,
  canvasId: string,
) {
  await gate(d, who, projectId);
  const report = await canvasOr404(d, projectId, canvasId);
  const loop = await d.store.loopForReport(canvasId);
  const config = await d.store.latestConfig(canvasId);
  const [generation] = await d.store.generations(canvasId, 1);
  return {
    id: canvasId,
    name: displayName(loop, report),
    kind: "canvas",
    loop: loop ? loopPayload(loop) : null,
    latest_config: config,
    latest_generation: generation ?? null,
  };
}

/** GET /agentic/projects/{p}/canvases/{id}/history */
export async function canvasHistory(
  d: CanvasDeps,
  who: Signed,
  projectId: string,
  _chatId: string | null,
  canvasId: string,
  limit: number,
) {
  await gate(d, who, projectId);
  const report = await canvasOr404(d, projectId, canvasId);
  const history = await buildCanvasHistory(d.store, canvasId, Math.min(limit, 100));
  const loop = await d.store.loopForReport(canvasId);
  return { id: canvasId, name: displayName(loop, report), history };
}

// ── writes ──────────────────────────────────────────────────────────────

function briefWithStandingEdit(brief: string, instruction: string): string {
  const b = brief.trim();
  const line = `- ${instruction.trim()}`;
  if (b.includes("Standing edits:") && b.includes(line)) return b;
  if (b.includes("Standing edits:")) return `${b}\n${line}`;
  return `${b}\n\nStanding edits:\n${line}`.trim();
}

/**
 * A direct edit from the chat: the instruction joins the brief as a standing edit (so
 * later ticks keep it), and the edited HTML becomes the latest generation at once.
 * The config revision is written before the HTML is checked, as before, so a refused
 * HTML still leaves the standing edit behind.
 */
export async function editCanvas(
  d: CanvasDeps,
  who: Signed,
  projectId: string,
  chatId: string | null,
  canvasId: string,
  instruction: string,
  contentHtml: string,
) {
  await gate(d, who, projectId);
  await canvasOr404(d, projectId, canvasId);
  return asBadRequest(async () => {
    const normalized = instruction.trim();
    if (!normalized) throw new CanvasValueError("instruction is required");
    const config = await d.store.latestConfig(canvasId);
    if (!config) throw new CanvasValueError("Canvas config not found");
    const loop = await d.store.loopForReport(canvasId);
    if (!loop) throw new CanvasValueError("Canvas loop not found");
    const gather = config.gather_spec;
    const revision = await d.store.insertConfigRevision({
      id: newId(),
      reportId: canvasId,
      brief: briefWithStandingEdit(String(config.brief ?? ""), normalized),
      gatherSpec:
        gather && typeof gather === "object" && !Array.isArray(gather) && Object.keys(gather).length
          ? gather
          : { window_minutes: 60 },
      tabs: normalizeCanvasTabs(Array.isArray(config.tabs) ? config.tabs : null),
      cadenceMinutes: Number(config.cadence_minutes) || DEFAULT_CADENCE_MINUTES,
      createdBy: who.directusUserId,
      note: "direct edit",
      now: d.now(),
    });
    const sanitized = sanitizeCanvasHtml(contentHtml);
    const detail = [`direct edit: ${normalized}`, ...(chatId ? [`chat_id=${chatId}`] : [])].join(
      "; ",
    );
    const generation = await d.store.insertGeneration({
      id: newId(),
      reportId: canvasId,
      configRevisionId: String(revision.id),
      contentHtml: sanitized.html,
      tickKind: "edited",
      detail,
      now: d.now(),
    });
    await d.store.insertLoopRun({
      id: newId(),
      loopId: String(loop.id),
      detail,
      generationId: String(generation.id),
      at: d.now().toISOString(),
    });
    await d.publishGeneration(canvasId);
    await d.store.updateLoop(String(loop.id), { failure_count: 0 }, d.now());
    return {
      id: canvasId,
      status: "edited",
      generation,
      config_revision: revision,
    };
  });
}

/** POST /agentic/projects/{p}/canvases/{id}/host-items */
export async function addCanvasHostItem(
  d: CanvasDeps,
  who: Signed,
  projectId: string,
  chatId: string | null,
  canvasId: string,
  body: { text: string; target_tab: string; person?: string | null; message_id?: string | null },
) {
  await gate(d, who, projectId);
  await canvasOr404(d, projectId, canvasId);
  return asBadRequest(async () => {
    const text = body.text.trim();
    if (!text) throw new CanvasValueError("text is required");
    const loop = await d.store.loopForReport(canvasId);
    if (!loop) throw new CanvasValueError("Canvas loop not found");
    const item = hostItem(
      {
        text,
        targetTab: body.target_tab,
        person: body.person ?? null,
        chatId,
        messageId: body.message_id ?? null,
      },
      d.now(),
    );
    const state = appendHostItem(freshCanvasState(loop), item);
    const updated = await d.store.updateLoop(String(loop.id), statePatch(state), d.now());
    await enqueueTick(d, String(loop.id), "manual");
    return { status: "added", host_item: item, loop: updated };
  });
}

/**
 * POST /agentic/projects/{p}/canvases/{id}/host-items/remove. A refused removal answers
 * 400 like an add; the Python route let the ValueError escape as a 500.
 */
export async function removeCanvasHostItem(
  d: CanvasDeps,
  who: Signed,
  projectId: string,
  chatId: string | null,
  canvasId: string,
  body: { item: string; message_id?: string | null },
) {
  await gate(d, who, projectId);
  await canvasOr404(d, projectId, canvasId);
  return asBadRequest(async () => {
    const needle = body.item.trim();
    if (!needle) throw new CanvasValueError("item is required");
    const loop = await d.store.loopForReport(canvasId);
    if (!loop) throw new CanvasValueError("Canvas loop not found");
    const [state, removed] = removeHostItem(freshCanvasState(loop), needle, d.now());
    const updated = await d.store.updateLoop(String(loop.id), statePatch(state), d.now());
    if (removed) await enqueueTick(d, String(loop.id), "manual");
    return {
      status: removed ? "removed" : "not_found",
      item: needle,
      chat_id: chatId,
      message_id: body.message_id ?? null,
      loop: updated,
    };
  });
}

function parseTime(v: unknown): Date | null {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** POST /agentic/projects/{p}/canvases/{id}/loop/{action} */
export async function canvasLoop(
  d: CanvasDeps,
  who: Signed,
  projectId: string,
  _chatId: string | null,
  canvasId: string,
  action: string,
) {
  await gate(d, who, projectId);
  if (!(LOOP_ACTIONS as readonly string[]).includes(action))
    throw new NotFoundError("Canvas loop action not found");
  await canvasOr404(d, projectId, canvasId);
  const loop = await d.store.loopForReport(canvasId);
  if (!loop) throw new NotFoundError("Canvas loop not found");
  const loopId = String(loop.id);
  const nowIso = d.now().toISOString();
  let updated: Obj;
  if (action === "pause") {
    if (loop.status === "stopped") return loopPayload(loop);
    await d.store.cancelPendingTasks(TASK_CANVAS_TICK, { loop_id: loopId }, nowIso);
    updated = await d.store.updateLoop(loopId, { status: "paused" }, d.now());
  } else if (action === "resume") {
    const expires = parseTime(loop.expires_at);
    if (loop.status === "expired" || loop.status === "stopped" || (expires && expires <= d.now()))
      throw new ConflictError("This loop has ended");
    updated = await d.store.updateLoop(loopId, { status: "active", failure_count: 0 }, d.now());
    await enqueueTick(d, loopId);
  } else {
    await d.store.cancelPendingTasks(TASK_CANVAS_TICK, { loop_id: loopId }, nowIso);
    updated = await d.store.updateLoop(loopId, { status: "stopped" }, d.now());
  }
  return loopPayload(updated);
}
