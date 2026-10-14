import { NotFoundError } from "@dembrane/core";
import { type Ctx, type Env, requireUser, type Signed } from "@dembrane/http";
import type { Hub } from "@dembrane/realtime";
import { Hono } from "hono";
import { requirePopcornEnabled, requireProjectPopcornEnabled } from "./access";
import { updateStream } from "./events";
import { asId } from "./py";
import { binary, html, illustrationBytes, logoBytes, webpName } from "./routes";
import { bundleForReport, type PopcornDeps } from "./service";
import type { Row } from "./storage";
import { renderPopcornPage } from "./view";

/**
 * A demo's deck before it is public, for dembrane staff: the page, the data, the drawings
 * and the stream a room gets from the public link, served by the demo's id instead of the
 * public token. It is the room's deck, never the host's: no passages, no dashboard links.
 *
 * This module only serves. Who may open which demo is `open` (@dembrane/accounts): it
 * checks the staff permission, that the demo is a finished draft or published, and
 * answers the one session the demo build seeded for that language. Nothing here takes a
 * session or a project from the caller, so staff rights still open no customer's project.
 */

/** What the caller is after: the page a person opens, what fills it, or its drawings. */
export type DeckPart = "page" | "data" | "asset";

export interface DraftDeckDeps extends PopcornDeps {
  readonly hub: () => Promise<Hub>;
  /** The session to serve for this demo and language, or a refusal. */
  readonly open: (
    who: Signed,
    demoId: string,
    language: string,
    part: DeckPart,
    requestId: string,
  ) => Promise<{ reportId: string }>;
}

const NO_STORE = { "Cache-Control": "no-store" };

export function draftDeckRoutes(deps: DraftDeckDeps) {
  const d = deps;
  const app = new Hono<Env>();
  const base = "/api/v2/admin/accounts/demos/:demoId/deck/:language";

  const session = async (c: Ctx, part: DeckPart): Promise<{ report: Row; project: Row }> => {
    requirePopcornEnabled(d.flags);
    const who = requireUser(c);
    const { reportId } = await d.open(
      who,
      c.req.param("demoId") as string,
      c.req.param("language") as string,
      part,
      c.get("requestId"),
    );
    const report = await d.store.report(reportId);
    const projectId = report && !report.deleted_at ? asId(report.project_id) : null;
    const project = projectId ? await d.store.project(projectId) : null;
    if (!report || !project || project.deleted_at) throw new NotFoundError("demo.not_found");
    requireProjectPopcornEnabled(d.flags, project);
    return { report, project };
  };

  // The page reads `data/bundle.json` relative to its own address, so the address ends in
  // a slash; both spellings serve the same document.
  const page = async (c: Ctx) => {
    await session(c, "page");
    return html(renderPopcornPage({ mode: "public" }));
  };
  app.get(base, page);
  app.get(`${base}/`, page);

  app.get(`${base}/data/bundle.json`, async (c) => {
    const { report, project } = await session(c, "data");
    return c.json(await bundleForReport(d, report, project), 200, NO_STORE);
  });

  app.get(`${base}/events`, async (c) => {
    const { report } = await session(c, "asset");
    return updateStream(c, d.hub, String(report.id));
  });

  app.get(`${base}/logo.png`, async (c) => {
    await session(c, "asset");
    return binary(logoBytes(), "image/png", { "Cache-Control": "private, max-age=86400" });
  });

  app.get(`${base}/illustrations/:file`, async (c) => {
    const name = webpName(c.req.param("file"));
    if (name === null) return c.notFound();
    const bytes = illustrationBytes(name);
    if (!bytes) throw new NotFoundError("popcorn.illustration_not_found");
    await session(c, "asset");
    return binary(bytes, "image/webp", { "Cache-Control": "private, max-age=86400" });
  });

  return app;
}
