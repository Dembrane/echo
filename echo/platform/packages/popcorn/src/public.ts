import { NotFoundError, RateLimitedError } from "@dembrane/core";
import type { Env } from "@dembrane/http";
import { p } from "@dembrane/legacy-shape";
import type { Limit } from "@dembrane/ratelimit";
import type { Hub } from "@dembrane/realtime";
import { type Context, Hono } from "hono";
import { getConnInfo } from "hono/bun";
import {
  requirePopcornEnabled,
  requirePresentEnabled,
  requireProjectPopcornEnabled,
} from "./access";
import { updateStream } from "./events";
import type { Json } from "./py";
import { asId, dict, pyStr } from "./py";
import { binary, illustrationBytes, logoBytes, webpName } from "./routes";
import { bundleForReport, loadSettingsFor, type PopcornDeps } from "./service";
import { audienceManifest } from "./settings";
import type { Row } from "./storage";
import { continueSnippet, NOT_LIVE_PAGE, renderPopcornPage } from "./view";

/**
 * Public, embeddable popcorn pages under /api/v2/popcorn/public/{token}. No auth: the token
 * is the capability, honoured only while the host has published the deck. The page only
 * ever sees the assembled bundle; nothing else about the project leaves.
 */

/** The map a presentation shows the room; Present owns it. */
export type AudienceMap = (args: {
  projectId: string;
  settings: Json;
  nodeLimit: number | null;
  edgeLimit: number | null;
  report: Row;
}) => Promise<Json>;

/** The answer while no map exists for the project, which is the answer Present gives too. */
export const mapNotReady: AudienceMap = async () => {
  throw new NotFoundError("present.map_results_not_ready");
};

export interface PublicRoutesDeps extends PopcornDeps {
  readonly hub: () => Promise<Hub>;
  readonly audienceMap: AudienceMap;
}

const NO_STORE = { "Cache-Control": "no-store" };
/** Tokens are urlsafe base64 from token_urlsafe; nothing else is a token. */
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
// Sized for a venue behind one NAT: screens and phones share an address and every one of
// them reads the bundle on each update.
const PAGE_LIMIT: Limit = { name: "popcorn_public_page", capacity: 300, windowSeconds: 60 };
const DATA_LIMIT: Limit = { name: "popcorn_public_data", capacity: 6000, windowSeconds: 60 };
// Open streams per API process: a room's screens and phones share a token and an address.
const MAX_EVENT_STREAMS = 1000;
const MAX_EVENT_STREAMS_PER_VIEWER = 100;
// An open stream asks at every heartbeat whether the deck is still published; screens
// following one token share the answer for a moment.
const PUBLISHED_CHECK_MS = 10_000;
const publishedChecks = new Map<string, { at: number; published: boolean }>();

/** First X-Forwarded-For hop, else the peer, as the old limiter keyed it (spec 7 L-20). */
function clientIp(c: Context): string {
  const header = c.req.header("x-forwarded-for");
  if (header) return header.split(",")[0]?.trim() ?? "";
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** The embed config of the host's preview and of an embedded public deck. */
export function deckEmbed(adminBaseUrl: string, presentationId: string, preview = false) {
  let origin = "";
  try {
    const u = new URL(adminBaseUrl);
    origin = `${u.protocol}//${u.host}`;
  } catch {
    origin = "://";
  }
  return {
    mode: "public",
    presentationId,
    parentOrigin: origin,
    ...(preview && { preview: true }),
  };
}

export function publicRoutes(deps: PublicRoutesDeps) {
  const d = deps;
  const app = new Hono<Env>();
  const base = "/api/v2/popcorn/public";
  const gate = () => requirePopcornEnabled(d.flags);

  const published = async (token: string): Promise<{ report: Row; project: Row }> => {
    if (!TOKEN.test(token)) throw new NotFoundError("popcorn.public_not_found");
    const report = token.length >= 16 ? await d.store.reportByToken(token) : null;
    if (!report) throw new NotFoundError("popcorn.public_not_found");
    const projectId = asId(report.project_id);
    const project = projectId ? await d.store.project(projectId) : null;
    if (!project || project.deleted_at) throw new NotFoundError("popcorn.public_not_found");
    requireProjectPopcornEnabled(d.flags, project);
    if (!(await loadSettingsFor(d.store, report)).public)
      throw new NotFoundError("popcorn.public_not_found");
    return { report, project };
  };

  const stillPublished = async (token: string): Promise<boolean> => {
    const now = performance.now();
    const checked = publishedChecks.get(token);
    if (checked && now - checked.at < PUBLISHED_CHECK_MS) return checked.published;
    let ok: boolean;
    try {
      await published(token);
      ok = true;
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
      ok = false;
    }
    if (publishedChecks.size > 10_000) publishedChecks.clear();
    publishedChecks.set(token, { at: now, published: ok });
    return ok;
  };

  // The page fetches `data/bundle.json` relative to its own address, so the canonical
  // address ends in a slash; both spellings serve the same document.
  const page = async (c: Context<Env>) => {
    gate();
    await d.limiter.check(PAGE_LIMIT, clientIp(c));
    let report: Row;
    try {
      ({ report } = await published(c.req.param("token") ?? ""));
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
      // A stale link gets a page in the deck's own voice, not a JSON body.
      return new Response(NOT_LIVE_PAGE, {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8", ...NO_STORE },
      });
    }
    const embedded = c.req.query("embedded") === "1";
    const embed = embedded ? deckEmbed(d.adminBaseUrl, String(report.id)) : { mode: "public" };
    // A prospect's demo leads on to their organisation (set by the demo seed's prospect block).
    const demo = embedded
      ? {}
      : dict(dict((await d.store.loopForReport(String(report.id)))?.popcorn_state).demo);
    const onward =
      demo.synthetic === true &&
      typeof demo.continue_url === "string" &&
      /^https?:\/\//.test(demo.continue_url)
        ? continueSnippet(demo.continue_url, pyStr(demo.language))
        : "";
    return new Response(renderPopcornPage(embed, onward), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", ...NO_STORE },
    });
  };
  app.get(`${base}/:token`, page);
  app.get(`${base}/:token/`, page);

  // Referenced by the QR code's SVG; harmless to serve for any token.
  app.get(`${base}/:token/logo.png`, () => {
    gate();
    return binary(logoBytes(), "image/png", { "Cache-Control": "public, max-age=86400" });
  });

  app.get(`${base}/:token/illustrations/:file`, (c) => {
    gate();
    const name = webpName(c.req.param("file"));
    if (name === null) return c.notFound();
    const bytes = illustrationBytes(name);
    if (!bytes) throw new NotFoundError("popcorn.illustration_not_found");
    return binary(bytes, "image/webp", { "Cache-Control": "public, max-age=86400" });
  });

  app.get(`${base}/:token/data/bundle.json`, async (c) => {
    gate();
    if (!(await d.limiter.allow(DATA_LIMIT, clientIp(c))))
      throw new RateLimitedError("rate_limit.exceeded");
    const { report, project } = await published(c.req.param("token"));
    return c.json(await bundleForReport(d, report, project), 200, NO_STORE);
  });

  app.get(`${base}/:token/events`, async (c) => {
    gate();
    const ip = clientIp(c);
    await d.limiter.check(PAGE_LIMIT, ip);
    const token = c.req.param("token");
    const { report } = await published(token);
    return updateStream(c, d.hub, String(report.id), {
      maxStreams: MAX_EVENT_STREAMS,
      key: `${token}:${ip}`,
      maxStreamsPerKey: MAX_EVENT_STREAMS_PER_VIEWER,
      stillAllowed: () => stillPublished(token),
    });
  });

  app.get(`${base}/:token/audience`, async (c) => {
    gate();
    requirePresentEnabled(d.flags);
    await d.limiter.check(DATA_LIMIT, clientIp(c));
    const { report, project } = await published(c.req.param("token"));
    const settings = await loadSettingsFor(d.store, report);
    return c.json(
      {
        id: String(report.id),
        manifest: audienceManifest(settings),
        bundle: await bundleForReport(d, report, project, { host: false }),
      },
      200,
      NO_STORE,
    );
  });

  app.get(`${base}/:token/map`, async (c) => {
    gate();
    requirePresentEnabled(d.flags);
    const { query } = await p.validate(c.req, {
      query: {
        node_limit: p.optional(p.nullable(p.int()), null),
        edge_limit: p.optional(p.nullable(p.int()), null),
      },
    });
    await d.limiter.check(DATA_LIMIT, clientIp(c));
    const { report, project } = await published(c.req.param("token"));
    const settings = await loadSettingsFor(d.store, report);
    if (!(audienceManifest(settings).blocks as string[]).includes("map"))
      throw new NotFoundError("present.map_not_in_presentation");
    return c.json(
      await d.audienceMap({
        projectId: String(project.id),
        settings,
        nodeLimit: query.node_limit,
        edgeLimit: query.edge_limit,
        report,
      }),
      200,
      NO_STORE,
    );
  });

  return app;
}
