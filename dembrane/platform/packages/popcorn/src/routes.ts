import { readFileSync } from "node:fs";
import type { Access } from "@dembrane/access";
import type { Capture } from "@dembrane/analytics";
import { NotFoundError, ValidationError } from "@dembrane/core";
import { type Env, requireUser } from "@dembrane/http";
import { p } from "@dembrane/legacy-shape";
import type { Hub } from "@dembrane/realtime";
import { Hono } from "hono";
import {
  type AccessDeps,
  popcornProject,
  popcornReport,
  requirePolicy,
  requirePopcornEnabled,
  requirePresentEnabled,
} from "./access";
import { roomFiles, sampleBundle } from "./bundle";
import { updateStream } from "./events";
import { dict, type Json, orStr, parseDt, truthy } from "./py";
import {
  bundleForReport,
  createLock,
  createPopcorn,
  dispatchNow,
  ensurePublicToken,
  forgetBundle,
  goLive,
  InvalidHours,
  listVersions,
  loadSettingsFor,
  type PopcornDeps,
  popcornPayload,
  rateLimit,
  readiness,
  requestRerun,
  requireUnlockedFrame,
  retargetTranslation,
  rotatePublicToken,
  stopLive,
  updateSettings,
  versionFiles,
} from "./service";
import { expandSettingsPatch, LIVE_HOURS, requireBrandingTier } from "./settings";
import { createBody, excludeNone, liveBody, loopSettingsBody, settingsBody } from "./shapes";
import type { Row } from "./storage";
import { illustrationPath, logoPath, renderFlowPage, renderPopcornPage } from "./view";

export interface PopcornRoutesDeps extends PopcornDeps {
  readonly access: Access;
  /** The process's live-event hub, started on first use. */
  readonly hub: () => Promise<Hub>;
  readonly capture: Capture;
}

const NO_STORE = { "Cache-Control": "no-store" };
/** Saved runs are uuids; anything else never reaches the page or a query. */
const VERSION_ID = /^[0-9a-fA-F-]{36}$/;

function versionId(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!VERSION_ID.test(value)) throw new NotFoundError("Version not found");
  return value;
}

let logo: Uint8Array | null = null;
export function logoBytes(): Uint8Array {
  logo ??= readFileSync(logoPath());
  return logo;
}

const illustrations = new Map<string, Uint8Array>();
export function illustrationBytes(name: string): Uint8Array | null {
  const path = illustrationPath(name);
  if (!path) return null;
  let bytes = illustrations.get(name);
  if (!bytes) {
    bytes = readFileSync(path);
    illustrations.set(name, bytes);
  }
  return bytes;
}

/** `{name}.webp` as FastAPI matched it: anything else is no route at all. */
export function webpName(file: string): string | null {
  return file.endsWith(".webp") && file.length > 5 ? file.slice(0, -5) : null;
}

export function binary(bytes: Uint8Array, type: string, headers: Record<string, string> = {}) {
  return new Response(bytes as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: { "content-type": type, ...headers },
  });
}

export function html(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...NO_STORE },
  });
}

/** Live until the expiry, rounded up to the nearest duration the deprecated route allowed. */
function hoursUntil(expires: string | number, now: Date): number {
  let at: Date | null;
  if (typeof expires === "number" || /^[+-]?\d+(\.\d+)?$/.test(expires)) {
    const n = Number(expires);
    // pydantic reads a large number as milliseconds.
    at = new Date(Math.abs(n) > 2e10 ? n : n * 1000);
  } else at = parseDt(expires.length === 10 ? `${expires}T00:00:00` : expires);
  const left = ((at ?? now).getTime() - now.getTime()) / 3_600_000;
  return LIVE_HOURS.find((h) => h >= left) ?? 24;
}

/**
 * The dashboard's popcorn routes under /api/v2/bff/popcorn: the session, its settings, the
 * read-now, rerun and live controls, saved runs, and the host's deck with its data and
 * live stream. Paths, bodies and refusals match the Python BFF.
 */
export function popcornRoutes(deps: PopcornRoutesDeps) {
  const d = deps;
  const ad: AccessDeps = { access: deps.access, store: deps.store, flags: deps.flags };
  const app = new Hono<Env>();
  const base = "/api/v2/bff/popcorn";
  const gate = () => requirePopcornEnabled(d.flags);
  const loopOf = async (report: Row) => {
    const loop = await d.store.loopForReport(String(report.id));
    if (!loop) throw new NotFoundError("Popcorn loop not found");
    return loop;
  };
  const payload = (report: Row) => popcornPayload(d.store, report);

  app.get(base, async (c) => {
    gate();
    const who = requireUser(c);
    const { query } = await p.validate(c.req, { query: { project_id: p.required(p.str()) } });
    await popcornProject(ad, who, query.project_id, "project:read");
    const report = await d.store.popcornReport(query.project_id);
    if (report) return c.json({ popcorn: await payload(report) });
    return c.json({ popcorn: null, readiness: await readiness(d.store, query.project_id) });
  });

  app.post(base, async (c) => {
    gate();
    const who = requireUser(c);
    const { body } = await p.validate(c.req, { body: createBody });
    const b = body.data;
    await popcornProject(ad, who, b.project_id, "project:update");
    // The lock the default presentation takes: one session per project.
    const created = await createLock(d, b.project_id, async (store, tx) => {
      const existing = await store.popcornReport(b.project_id);
      if (existing) return { existing };
      return {
        created: await createPopcorn(d, tx, {
          projectId: b.project_id,
          title: b.title.trim(),
          client: (b.client ?? "").trim() || null,
          actor: who.directusUserId,
        }),
      };
    });
    if ("existing" in created && created.existing)
      return c.json(await payload(created.existing), 201);
    const report = (created as { created: { report: Row } }).created.report;
    if (b.voice !== null) await updateSettings(d, report, { voice: excludeNone(b.voice) as Json });
    return c.json(await payload(report), 201);
  });

  // ── try it: upstream's sample deck, no session and no model call ─────

  app.get(`${base}/sample/view/`, (c) => {
    gate();
    requireUser(c);
    return html(renderPopcornPage({ mode: "sample" }));
  });

  app.get(`${base}/sample/view/data/bundle.json`, (c) => {
    gate();
    requireUser(c);
    return c.json(sampleBundle(), 200, { "Cache-Control": "private, max-age=60" });
  });

  app.get(`${base}/sample/view/logo.png`, (c) => {
    gate();
    requireUser(c);
    return binary(logoBytes(), "image/png");
  });

  app.get(`${base}/sample/view/illustrations/:file`, (c) => {
    gate();
    requireUser(c);
    const name = webpName(c.req.param("file"));
    if (name === null) return c.notFound();
    const bytes = illustrationBytes(name);
    if (!bytes) throw new NotFoundError("Not found");
    return binary(bytes, "image/webp");
  });

  // ── one session ────────────────────────────────────────────────────

  app.get(`${base}/:popcorn_id`, async (c) => {
    gate();
    const who = requireUser(c);
    const { report } = await popcornReport(ad, who, c.req.param("popcorn_id"));
    return c.json(await payload(report));
  });

  app.patch(`${base}/:popcorn_id/settings`, async (c) => {
    gate();
    const who = requireUser(c);
    const { body } = await p.validate(c.req, { body: settingsBody });
    const { report, project, access } = await popcornReport(
      ad,
      who,
      c.req.param("popcorn_id"),
      "project:update",
    );
    let patch = excludeNone(body.data) as Json;
    if ("presentation" in patch) requirePresentEnabled(d.flags);
    if ("disclosure" in patch || "notice" in patch)
      await requireUnlockedFrame(d.store, report, await d.store.loopForReport(String(report.id)));
    requireBrandingTier(orStr(access.tier, "free"), patch.show_branding === false);
    if (truthy(patch.public)) {
      // H-11: a public link to project analysis is sharing, so it needs what sharing needs.
      const projectId = String(report.project_id);
      await requirePolicy(ad, who, projectId, "project:share");
      await requirePolicy(ad, who, projectId, "report:publish");
      // L-8: a link that was taken down comes back as a new link, never the old one.
      if (!(await loadSettingsFor(d.store, report)).public) await rotatePublicToken(d, report);
      else await ensurePublicToken(d, report);
    }
    const before = await loadSettingsFor(d.store, report);
    patch = expandSettingsPatch(patch, truthy(before.presentation));
    const updated = await updateSettings(d, report, patch);
    // A new language is translated now, not at the next scheduled read.
    await retargetTranslation(d, report, { before, after: updated, project: projectRow(project) });
    const fresh = await d.store.report(String(report.id));
    return c.json(await payload(fresh ?? report));
  });

  app.post(`${base}/:popcorn_id/refresh`, async (c) => {
    gate();
    const who = requireUser(c);
    const id = c.req.param("popcorn_id");
    const { report } = await popcornReport(ad, who, id, "project:update");
    const loop = await loopOf(report);
    await rateLimit(d, id);
    // Handed to a worker: a manual pass reads every conversation and must not hold the request.
    await dispatchNow(d, String(loop.id), "manual");
    return c.json({ tick: "queued" }, 202);
  });

  app.post(`${base}/:popcorn_id/rerun`, async (c) => {
    gate();
    const who = requireUser(c);
    const id = c.req.param("popcorn_id");
    const { report } = await popcornReport(ad, who, id, "project:update");
    const loop = await loopOf(report);
    await rateLimit(d, id, "rerun");
    await requestRerun(d, loop);
    forgetBundle(String(report.id));
    return c.json({ tick: "queued" }, 202);
  });

  app.post(`${base}/:popcorn_id/live`, async (c) => {
    gate();
    const who = requireUser(c);
    const { body } = await p.validate(c.req, { body: liveBody });
    const { report } = await popcornReport(ad, who, c.req.param("popcorn_id"), "project:update");
    const loop = await loopOf(report);
    try {
      await goLive(d, loop, body.data.hours);
    } catch (err) {
      if (err instanceof InvalidHours) throw new ValidationError(err.message);
      throw err;
    }
    return c.json(await payload(report));
  });

  app.post(`${base}/:popcorn_id/live/stop`, async (c) => {
    gate();
    const who = requireUser(c);
    const { report } = await popcornReport(ad, who, c.req.param("popcorn_id"), "project:update");
    await stopLive(d, await loopOf(report));
    return c.json(await payload(report));
  });

  // One release of compatibility for dashboards deployed ahead of the server: the old loop
  // routes map onto the modes. Remove them one release after the dashboard stops calling.
  app.post(`${base}/:popcorn_id/loop/:action`, async (c) => {
    gate();
    const who = requireUser(c);
    const action = c.req.param("action");
    if (!["pause", "resume", "stop", "go-live"].includes(action))
      throw new NotFoundError("Popcorn loop action not found");
    const { report } = await popcornReport(ad, who, c.req.param("popcorn_id"), "project:update");
    const loop = await loopOf(report);
    if (action === "go-live" || action === "resume") await goLive(d, loop, 8);
    else await stopLive(d, loop);
    return c.json(await payload(report));
  });

  app.patch(`${base}/:popcorn_id/loop`, async (c) => {
    gate();
    const who = requireUser(c);
    const { body } = await p.validate(c.req, { body: loopSettingsBody });
    const { report } = await popcornReport(ad, who, c.req.param("popcorn_id"), "project:update");
    await goLive(d, await loopOf(report), hoursUntil(body.data.expires_at, d.now()));
    return c.json(await payload(report));
  });

  app.get(`${base}/:popcorn_id/events`, async (c) => {
    gate();
    const who = requireUser(c);
    const { report } = await popcornReport(ad, who, c.req.param("popcorn_id"));
    return updateStream(c, d.hub, String(report.id));
  });

  // ── the presentation itself, for hosts ───────────────────────────────

  app.get(`${base}/:popcorn_id/versions`, async (c) => {
    gate();
    const who = requireUser(c);
    const { report } = await popcornReport(ad, who, c.req.param("popcorn_id"));
    return c.json(await listVersions(d.store, String(report.id)));
  });

  app.get(`${base}/:popcorn_id/view/`, async (c) => {
    gate();
    const who = requireUser(c);
    await popcornReport(ad, who, c.req.param("popcorn_id"));
    // The page picks a saved run from its own query string; a bad link fails early here.
    versionId(c.req.query("version"));
    return html(renderPopcornPage({ mode: "host" }));
  });

  app.get(`${base}/:popcorn_id/view/events`, async (c) => {
    gate();
    const who = requireUser(c);
    const { report } = await popcornReport(ad, who, c.req.param("popcorn_id"));
    return updateStream(c, d.hub, String(report.id));
  });

  app.get(`${base}/:popcorn_id/view/flow/`, async (c) => {
    gate();
    const who = requireUser(c);
    await popcornReport(ad, who, c.req.param("popcorn_id"));
    if (!d.showFlow) throw new NotFoundError("Not found");
    return html(renderFlowPage());
  });

  app.get(`${base}/:popcorn_id/view/logo.png`, async (c) => {
    gate();
    const who = requireUser(c);
    await popcornReport(ad, who, c.req.param("popcorn_id"));
    return binary(logoBytes(), "image/png", { "Cache-Control": "private, max-age=86400" });
  });

  app.get(`${base}/:popcorn_id/view/illustrations/:file`, async (c) => {
    gate();
    const who = requireUser(c);
    const name = webpName(c.req.param("file"));
    if (name === null) return c.notFound();
    const bytes = illustrationBytes(name);
    if (!bytes) throw new NotFoundError("Not found");
    await popcornReport(ad, who, c.req.param("popcorn_id"));
    return binary(bytes, "image/webp", { "Cache-Control": "private, max-age=86400" });
  });

  app.get(`${base}/:popcorn_id/view/data/bundle.json`, async (c) => {
    gate();
    const who = requireUser(c);
    const { report, project } = await popcornReport(ad, who, c.req.param("popcorn_id"));
    const version = versionId(c.req.query("version"));
    const view = c.req.query("view");
    if (version) {
      let files = await versionFiles(d.store, String(report.id), version);
      if (files === null) throw new NotFoundError("Version not found");
      if (view === "room") {
        // The wall never sees a passage, a dashboard link or a name the setting withholds.
        const settings = await loadSettingsFor(d.store, report);
        files = roomFiles(files, settings.public_labels !== "names");
      }
      return c.json({ run: null, version, files }, 200, {
        "Cache-Control": "private, max-age=300",
      });
    }
    const bundle = await bundleForReport(d, report, project, { host: view !== "room" });
    return c.json(bundle, 200, NO_STORE);
  });

  app.post(`${base}/:popcorn_id/view/data/latency`, async (c) => {
    gate();
    const who = requireUser(c);
    const { report, project } = await popcornReport(ad, who, c.req.param("popcorn_id"));
    // sendBeacon may post the body as text, so it is read by hand.
    let ms = 0;
    try {
      const text = await c.req.text();
      const parsed = JSON.parse(text || "{}");
      const raw = dict(parsed).ms;
      ms = truthy(raw) ? Math.trunc(Number(raw)) : 0;
      if (Number.isNaN(ms)) ms = 0;
    } catch {
      ms = 0;
    }
    await d.capture(who.directusUserId, "popcorn_first_phrase_late", {
      popcorn_id: String(report.id),
      project_id: project.id === undefined || project.id === null ? null : String(project.id),
      ms: Math.max(0, Math.min(ms, 600_000)),
    });
    return c.body(null, 204);
  });

  return app;
}

/** The project row as the Python dicts carried it into settings resolution. */
export function projectRow(project: Row): Json {
  return project as Json;
}
