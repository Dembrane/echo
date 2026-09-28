import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  RateLimitedError,
  StatusError,
  ValidationError,
} from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import type { Completer } from "@dembrane/llm";
import type { RateLimiter } from "@dembrane/ratelimit";
import { type AccessDeps, canvasProject, canvasReport } from "./access";
import { executeGatherSpec, gatherHasTranscript } from "./gather";
import { applyModelExtraction, freshCanvasState, normalizeCanvasTabs, tabsEqual } from "./ledgers";
import { directusTime, isRecord, type Json, orStr, parseDt, pyStr, truthy, utcNowIso } from "./py";
import { MAX_HTML_BYTES, sanitizeCanvasHtml } from "./sanitize";
import type { Row } from "./storage";
import { extractLivingCanvasUpdate, generateHostGuide, renderWall } from "./ticks";

export const DEFAULT_CADENCE_MINUTES = 5;

/** What the routes' operations need. */
export interface CanvasDeps extends AccessDeps {
  readonly completer: Completer;
  readonly limiter: RateLimiter;
  readonly now: () => Date;
  /** Starts a tick now (the manual refresh), on the worker. */
  readonly startTick: (loopId: string, tickKind: string) => Promise<void>;
  /** Tells open canvas pages a new generation exists. */
  readonly nudge: (reportId: string) => Promise<void>;
}

/** The Redis SET NX guards of the Python routes, now Postgres counters with capacity 1. */
const PREVIEW_LIMIT = { name: "canvas_preview", capacity: 1, windowSeconds: 10 };
const REFRESH_LIMIT = { name: "canvas_refresh", capacity: 1, windowSeconds: 30 };

const iso = (d: Date) => utcNowIso(d);

// ── Directus-shaped rows ─────────────────────────────────────────────

function t(v: unknown): string | null {
  return v === null || v === undefined ? null : directusTime(v);
}

function generationDoc(r: Row): Json {
  return {
    id: r.id,
    report_id: r.report_id ?? null,
    config_revision_id: r.config_revision_id ?? null,
    content_html: r.content_html ?? null,
    status: r.status ?? null,
    tick_kind: r.tick_kind ?? null,
    detail: r.detail ?? null,
    created_at: t(r.created_at),
  };
}

function loopDoc(loop: Row, run: Row | null): Json {
  return {
    status: loop.status ?? null,
    expires_at: t(loop.expires_at),
    cadence_minutes: loop.cadence_minutes ?? null,
    last_run_started_at: t(run?.started_at),
    last_run_status: run?.status ?? null,
    last_run_detail: run?.detail ?? null,
  };
}

function loopSettingsDoc(loop: Row): Json {
  return {
    status: loop.status ?? null,
    expires_at: t(loop.expires_at),
    cadence_minutes: loop.cadence_minutes ?? null,
    last_run_started_at: t(loop.last_run_started_at),
    last_run_status: loop.last_run_status ?? null,
    last_run_detail: loop.last_run_detail ?? null,
  };
}

async function liveChatId(d: CanvasDeps, chatId: unknown, projectId: string | null) {
  const id = truthy(chatId) ? pyStr(chatId) : null;
  if (!id || !projectId) return null;
  const chat = await d.store.chat(id);
  if (!chat || chat.deleted_at || String(chat.project_id ?? "") !== projectId) return null;
  return id;
}

export async function canvasPayload(d: CanvasDeps, report: Row): Promise<Json> {
  const reportId = String(report.id);
  const loop = await d.store.loopForReport(reportId);
  const run = loop ? await d.store.latestRun(String(loop.id)) : null;
  const config = await d.store.latestConfig(reportId);
  const [generation] = await d.store.generations(reportId, 1);
  const projectId = truthy(report.project_id) ? String(report.project_id) : null;
  return {
    id: reportId,
    name: orStr(loop?.name) || orStr(report.user_instructions) || "Canvas",
    kind: "canvas",
    project_id: projectId,
    latest_generation: generation ? generationDoc(generation) : null,
    created_from_chat_id: await liveChatId(d, loop?.created_from_chat_id, projectId),
    updated_at: t(loop?.updated_at),
    config: config
      ? {
          brief: config.brief ?? null,
          gather_spec: config.gather_spec ?? null,
          tabs: config.tabs ?? null,
          cadence_minutes: config.cadence_minutes ?? null,
          created_at: t(config.created_at),
        }
      : null,
    loop: loop ? loopDoc(loop, run) : null,
  };
}

// ── reads ─────────────────────────────────────────────────────────────

export async function listCanvases(d: CanvasDeps, who: Signed, projectId: string) {
  await canvasProject(d, who, projectId, "project:read");
  const out: Json[] = [];
  for (const report of await d.store.canvasReports(projectId)) {
    const reportId = String(report.id);
    const loop = await d.store.loopForReport(reportId);
    const run = loop ? await d.store.latestRun(String(loop.id)) : null;
    const [generation] = await d.store.generations(reportId, 1);
    out.push({
      id: reportId,
      name: orStr(loop?.name) || orStr(report.user_instructions) || "Canvas",
      kind: "canvas",
      created_at: t(report.date_created),
      latest_generation_at: t(generation?.created_at),
      updated_at: t(loop?.updated_at),
      loop: loop ? loopDoc(loop, run) : null,
    });
  }
  return out;
}

export async function getCanvas(d: CanvasDeps, who: Signed, canvasId: string) {
  const { report } = await canvasReport(d, who, canvasId);
  return canvasPayload(d, report);
}

export async function listGenerations(d: CanvasDeps, who: Signed, canvasId: string, limit: number) {
  const { report } = await canvasReport(d, who, canvasId);
  return (await d.store.generations(String(report.id), limit)).map(generationDoc);
}

/** Access for the live stream; the caller then streams the report's nudges. */
export async function canvasForEvents(d: CanvasDeps, who: Signed, canvasId: string) {
  const { report } = await canvasReport(d, who, canvasId);
  return String(report.id);
}

export async function latestGenerationId(d: CanvasDeps, reportId: string): Promise<unknown> {
  const [generation] = await d.store.generations(reportId, 1);
  return generation?.id ?? null;
}

// ── writes ────────────────────────────────────────────────────────────

function checkExpiry(expiresAt: Date, now: Date) {
  if (expiresAt.getTime() <= now.getTime()) throw new ValidationError("canvas.expiry_in_past");
  if (expiresAt.getTime() > now.getTime() + 7 * 24 * 3600_000)
    throw new ValidationError("canvas.expiry_too_far");
}

async function storeAppliedPreview(
  d: CanvasDeps,
  args: {
    reportId: string;
    configId: string;
    loopId: string;
    html: string;
    chatId: string | null;
  },
): Promise<Row> {
  const sanitized = sanitizeCanvasHtml(args.html, MAX_HTML_BYTES);
  const details = ["applied from chat preview"];
  if (args.chatId) details.push(`chat_id=${args.chatId}`);
  if (sanitized.strippedReferences)
    details.push(`stripped ${sanitized.strippedReferences} external reference(s)`);
  const detail = details.join("; ");
  const generation = await d.store.insertGeneration({
    reportId: args.reportId,
    configRevisionId: args.configId,
    html: sanitized.html,
    status: "ok",
    tickKind: "applied",
    detail,
    now: iso(d.now()),
  });
  const recorded = iso(d.now());
  await d.store.insertRun({
    loopId: args.loopId,
    status: "ok",
    detail,
    generationId: String(generation.id),
    startedAt: recorded,
    finishedAt: recorded,
  });
  await d.nudge(args.reportId);
  return generation;
}

export interface CreateBody {
  project_id: string;
  name: string;
  brief: string;
  gather_spec: Json | null;
  cadence_minutes: number;
  expires_at: Date;
  created_from_chat_id: string | null;
  applied_preview_html: string | null;
  tabs: Json[] | null;
}

export async function createCanvas(d: CanvasDeps, who: Signed, body: CreateBody) {
  await canvasProject(d, who, body.project_id, "project:update");
  const now = d.now();
  checkExpiry(body.expires_at, now);
  const chatId = await liveChatId(d, body.created_from_chat_id, body.project_id);
  const cadence = body.cadence_minutes || DEFAULT_CADENCE_MINUTES;
  const stamp = iso(now);
  const report = await d.store.insertReport({
    projectId: body.project_id,
    name: body.name,
    userCreated: who.directusUserId,
    now: stamp,
  });
  const reportId = String(report.id);
  const config = await d.store.insertConfig({
    reportId,
    brief: body.brief,
    gatherSpec: truthy(body.gather_spec) ? body.gather_spec : { window_minutes: 60 },
    tabs: normalizeCanvasTabs(body.tabs),
    cadence,
    createdBy: who.directusUserId,
    note: "initial",
    now: stamp,
  });
  const loop = await d.store.insertLoop({
    projectId: body.project_id,
    reportId,
    name: body.name,
    expiresAt: iso(body.expires_at),
    cadence,
    actingUser: who.directusUserId,
    createdFromChatId: chatId,
    now: stamp,
  });
  if (body.applied_preview_html)
    await storeAppliedPreview(d, {
      reportId,
      configId: String(config.id),
      loopId: String(loop.id),
      html: body.applied_preview_html,
      chatId,
    });
  await d.store.scheduleTick({
    loopId: String(loop.id),
    tickKind: "scheduled",
    scheduledAt: iso(d.now()),
    now: iso(d.now()),
  });
  const fresh = await d.store.report(reportId);
  return canvasPayload(d, fresh ?? report);
}

export interface UpdateBody {
  name: string;
  brief: string;
  gather_spec: Json | null;
  cadence_minutes: number;
  created_from_chat_id: string | null;
  applied_preview_html: string | null;
  tabs: Json[] | null;
}

export async function updateCanvas(d: CanvasDeps, who: Signed, canvasId: string, body: UpdateBody) {
  const { report } = await canvasReport(d, who, canvasId, "project:update");
  const reportId = String(report.id);
  const projectId = truthy(report.project_id) ? String(report.project_id) : null;
  const appliedFrom = await liveChatId(d, body.created_from_chat_id, projectId);
  const previous = await d.store.latestConfig(reportId);
  const loop = await d.store.loopForReport(reportId);
  const previousTabs = Array.isArray(previous?.tabs)
    ? previous?.tabs
    : Array.isArray(loop?.canvas_tabs)
      ? loop?.canvas_tabs
      : null;
  const effectiveTabs = normalizeCanvasTabs(body.tabs !== null ? body.tabs : previousTabs);
  const now = iso(d.now());
  const config = await d.store.insertConfig({
    reportId,
    brief: body.brief,
    gatherSpec: truthy(body.gather_spec) ? body.gather_spec : { window_minutes: 60 },
    tabs: normalizeCanvasTabs(effectiveTabs),
    cadence: body.cadence_minutes,
    createdBy: who.directusUserId,
    note: "chat update",
    now,
  });
  await d.store.renameReport(reportId, body.name, now);
  if (loop) {
    const loopId = String(loop.id);
    const tabsChanged = !tabsEqual(effectiveTabs, normalizeCanvasTabs(loop.canvas_tabs));
    await d.store.updateLoop(
      loopId,
      { name: body.name, cadence_minutes: body.cadence_minutes, failure_count: 0 },
      iso(d.now()),
    );
    let applied: Row | null = null;
    if (body.applied_preview_html)
      applied = await storeAppliedPreview(d, {
        reportId,
        configId: String(config.id),
        loopId,
        html: body.applied_preview_html,
        chatId: appliedFrom,
      });
    // A changed brief must force a redraw: a scheduled tick would be skipped by the cadence
    // window or as "no new content". With a preview applied, normal cadence resumes.
    await d.store.scheduleTick({
      loopId,
      tickKind: tabsChanged || !applied ? "manual" : "scheduled",
      scheduledAt: iso(d.now()),
      now: iso(d.now()),
    });
  }
  const fresh = await d.store.report(reportId);
  return canvasPayload(d, fresh ?? report);
}

async function loopOf(d: CanvasDeps, reportId: string): Promise<Row> {
  const loop = await d.store.loopForReport(reportId);
  if (!loop) throw new NotFoundError("canvas.loop_not_found");
  return loop;
}

export async function refreshCanvas(d: CanvasDeps, who: Signed, canvasId: string) {
  const { report } = await canvasReport(d, who, canvasId, "project:update");
  const loop = await loopOf(d, String(report.id));
  if (!(await d.limiter.allow(REFRESH_LIMIT, canvasId)))
    throw new RateLimitedError("canvas.just_refreshed");
  await d.startTick(String(loop.id), "manual");
  return { generation: "pending" };
}

export async function loopAction(d: CanvasDeps, who: Signed, canvasId: string, action: string) {
  const { report } = await canvasReport(d, who, canvasId, "project:update");
  const loop = await loopOf(d, String(report.id));
  const loopId = String(loop.id);
  const now = () => iso(d.now());
  let updated: Row | null = loop;
  if (action === "pause") {
    if (loop.status !== "stopped") {
      await d.store.cancelPendingTicks(loopId, now());
      updated = await d.store.updateLoop(loopId, { status: "paused" }, now());
    }
  } else if (action === "resume") {
    const expires = parseDt(loop.expires_at);
    if (
      loop.status === "expired" ||
      loop.status === "stopped" ||
      (expires !== null && expires.getTime() <= d.now().getTime())
    )
      throw new ConflictError("canvas.loop_ended");
    updated = await d.store.updateLoop(loopId, { status: "active", failure_count: 0 }, now());
    await d.store.scheduleTick({ loopId, tickKind: "scheduled", scheduledAt: now(), now: now() });
  } else if (action === "stop") {
    await d.store.cancelPendingTicks(loopId, now());
    updated = await d.store.updateLoop(loopId, { status: "stopped" }, now());
  } else {
    throw new BadRequestError("canvas.loop_action_unsupported", { params: { action } });
  }
  return loopSettingsDoc(updated ?? loop);
}

export async function patchLoop(
  d: CanvasDeps,
  who: Signed,
  canvasId: string,
  body: { cadence_minutes: number; expires_at: Date },
) {
  const { report } = await canvasReport(d, who, canvasId, "project:update");
  const loop = await loopOf(d, String(report.id));
  checkExpiry(body.expires_at, d.now());
  if (["expired", "stopped", "ended"].includes(pyStr(loop.status ?? null)))
    throw new ConflictError("canvas.loop_ended");
  const loopId = String(loop.id);
  const updated = await d.store.updateLoop(
    loopId,
    { cadence_minutes: body.cadence_minutes, expires_at: iso(body.expires_at), failure_count: 0 },
    iso(d.now()),
  );
  await d.store.cancelPendingTicks(loopId, iso(d.now()));
  if (updated?.status === "active")
    await d.store.scheduleTick({
      loopId,
      tickKind: "scheduled",
      scheduledAt: iso(d.now()),
      now: iso(d.now()),
    });
  return loopSettingsDoc(updated ?? loop);
}

export async function previewCanvas(
  d: CanvasDeps,
  who: Signed,
  body: { project_id: string; brief: string; gather_spec: Json | null; tabs: Json[] | null },
) {
  await canvasProject(d, who, body.project_id, "project:update");
  if (!(await d.limiter.allow(PREVIEW_LIMIT, body.project_id)))
    throw new RateLimitedError("canvas.just_previewed");
  const bundle = await executeGatherSpec(d, {
    projectId: body.project_id,
    actingUser: who.directusUserId,
    gatherSpec: body.gather_spec ?? {},
    previewSample: true,
    now: d.now(),
  });
  // The preview has no canvas yet; the Python read body.name here, which the body does
  // not have, so every preview with transcript failed. The project name stands in.
  const name = orStr(isRecord(bundle.project) ? bundle.project.name : null) || "Canvas";
  let state = freshCanvasState();
  if (body.tabs?.length) state.tabs = normalizeCanvasTabs(body.tabs);
  if (gatherHasTranscript(bundle)) {
    let extraction: Json;
    try {
      extraction = await extractLivingCanvasUpdate(d.completer, {
        bundle,
        state,
        reportName: name,
        brief: body.brief,
      });
    } catch (err) {
      throw new StatusError(502, "canvas.extraction_failed", {
        params: { reason: err instanceof Error ? err.message : String(err) },
      });
    }
    const [next, detail] = applyModelExtraction(state, bundle, extraction);
    state = next;
    try {
      state.host_guide = await generateHostGuide(d.completer, {
        reportName: name,
        brief: body.brief,
        state,
        recent: detail as unknown as Json,
        now: d.now(),
      });
    } catch {
      // The Open questions tab is optional in a preview.
    }
  }
  const raw = await renderWall(d.store, { state, bundle, reportName: name, reportId: null });
  return { content_html: sanitizeCanvasHtml(raw, MAX_HTML_BYTES).html };
}
