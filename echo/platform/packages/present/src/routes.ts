import type { Access } from "@echo/access";
import { NotFoundError, RateLimitedError, UnavailableError, ValidationError } from "@echo/core";
import { type Env, requireUser } from "@echo/http";
import { p } from "@echo/legacy-shape";
import {
  type AccessDeps,
  type AudienceMap,
  allows,
  audienceManifest,
  binary,
  bundleForReport,
  deckEmbed,
  dict,
  dispatchNow,
  ensurePublicToken,
  excludeNone,
  expandSettingsPatch,
  html,
  illustrationBytes,
  type Json,
  loadSettingsFor,
  logoBytes,
  mergeSettings,
  normalizeState,
  orStr,
  type PopcornDeps,
  popcornReport,
  projectJson,
  projectWith,
  type Row,
  rateLimit,
  readiness,
  renderPopcornPage,
  requireBrandingTier,
  requirePolicy,
  requirePresentEnabled,
  requireUnlockedFrame,
  retargetTranslation,
  rotatePublicToken,
  truthy,
  updateStream,
  webpName,
} from "@echo/popcorn";
import type { Hub } from "@echo/realtime";
import { type Context, Hono } from "hono";
import { audienceMap, type MapStore, MapUnavailable } from "./map";
import {
  adoptResults,
  availableBindings,
  conversationLegend,
  type DraftState,
  draftConflict,
  draftPayload,
  draftState,
  ensureDefault,
  payload,
  publishDraft,
  publishOpening,
  saveDraft,
} from "./service";
import { draftPatchBody, draftPublishBody, openingBody } from "./shapes";

export interface PresentRoutesDeps extends PopcornDeps {
  readonly access: Access;
  readonly hub: () => Promise<Hub>;
  readonly map: MapStore;
}

const NO_STORE = { "Cache-Control": "no-store" };
const limits = {
  node_limit: p.optional(p.nullable(p.int()), null),
  edge_limit: p.optional(p.nullable(p.int()), null),
};

/**
 * Present's entry points under /api/v2/bff/present: the draft editor, publishing, the
 * opening words, the project's default presentation, the audience's read-only
 * projections and the deck pages. Paths, bodies and refusals match the Python BFF.
 */
export function presentRoutes(deps: PresentRoutesDeps) {
  const d = deps;
  const ad: AccessDeps = { access: deps.access, store: deps.store, flags: deps.flags };
  const app = new Hono<Env>();
  const base = "/api/v2/bff/present";
  const gate = () => requirePresentEnabled(d.flags);

  const envelope = async (report: Row, project: Row, state: DraftState): Promise<Json> => {
    const out: Json = {
      presentation: await draftPayload(d, report, project, state.settings),
      revision: state.revision,
      has_changes:
        JSON.stringify(sorted(state.settings)) !== JSON.stringify(sorted(state.published)),
    };
    if (state.savedAt) out.saved_at = state.savedAt;
    return out;
  };

  /** _validate_draft_settings: the mark needs its tier, a demo's frame stays the demo's. */
  const validateDraft = async (report: Row, tier: string | null, settings: Json) => {
    requireBrandingTier(orStr(tier, "free"), settings.show_branding === false);
    await requireUnlockedFrame(
      d.store,
      report,
      await d.store.loopForReport(String(report.id)),
      settings,
    );
  };

  /** L-8, as on the popcorn settings route: a deck going public gets a fresh link. */
  const publicLink = async (report: Row, before: Json) => {
    if (!before.public) await rotatePublicToken(d, report);
    else await ensurePublicToken(d, report);
  };

  /** H-11, as on the popcorn settings route: going public is sharing. */
  const sharing = async (who: Parameters<typeof popcornReport>[1], report: Row) => {
    const projectId = String(report.project_id);
    await requirePolicy(ad, who, projectId, "project:share");
    await requirePolicy(ad, who, projectId, "report:publish");
  };

  const prepareBlock = async (report: Row, projectId: string, actorId: string, block: string) => {
    try {
      await rateLimit(d, String(report.id), `prepare:${block}`);
    } catch (err) {
      if (err instanceof RateLimitedError) return;
      throw err;
    }
    if (block === "map") {
      await d.map.requestGeneration(projectId, actorId);
      return;
    }
    const loop = await d.store.loopForReport(String(report.id));
    if (loop) await dispatchNow(d, String(loop.id), `prepare:${block}`);
  };

  const mapFor = async (
    report: Row,
    project: Row,
    settings: Json,
    query: { node_limit: number | null; edge_limit: number | null },
  ) => {
    if (!(audienceManifest(settings).blocks as string[]).includes("map"))
      throw new NotFoundError("Map is not in this presentation.");
    return audienceMap(d.map, {
      projectId: String(project.id),
      settings,
      nodeLimit: query.node_limit,
      edgeLimit: query.edge_limit,
      legend: await conversationLegend(d.store, report),
      excluded: () => d.deck.excludedObjectIds(String(project.id)),
    });
  };

  const id = (c: Context<Env>) => c.req.param("presentation_id") ?? "";

  app.get(`${base}/:presentation_id/draft`, async (c) => {
    gate();
    const who = requireUser(c);
    const { report, project } = await popcornReport(ad, who, id(c), "project:update");
    return c.json(await envelope(report, project, await draftState(d.store, report)));
  });

  app.patch(`${base}/:presentation_id/draft`, async (c) => {
    gate();
    const who = requireUser(c);
    const { body } = await p.validate(c.req, { body: draftPatchBody });
    const { report, project, access } = await popcornReport(ad, who, id(c), "project:update");
    const patch = expandSettingsPatch(excludeNone(body.data.patch) as Json);
    const current = await draftState(d.store, report);
    if (current.revision !== body.data.expected_revision) throw draftConflict();
    const candidate = mergeSettings(
      current.settings,
      patch,
      orStr(report.user_instructions, "Popcorn"),
    );
    await validateDraft(report, access.tier, candidate);
    const state = await saveDraft(d, report, patch, body.data.expected_revision);
    return c.json(await envelope(report, project, state));
  });

  app.post(`${base}/:presentation_id/publish`, async (c) => {
    gate();
    const who = requireUser(c);
    const { body } = await p.validate(c.req, { body: draftPublishBody });
    const { report, project, access } = await popcornReport(ad, who, id(c), "project:update");
    const before = await loadSettingsFor(d.store, report);
    const draft = await draftState(d.store, report);
    if (draft.revision !== body.data.expected_revision) throw draftConflict();
    await validateDraft(report, access.tier, draft.settings);
    // Checked before the write, so a refused publish leaves the room as it was.
    if (truthy(draft.settings.public)) await sharing(who, report);
    const state = await publishDraft(d, report, body.data.expected_revision);
    if (truthy(state.settings.public)) await publicLink(report, before);
    await retargetTranslation(d, report, {
      before,
      after: state.settings,
      project: projectJson(project),
    });
    const fresh = await d.store.report(String(report.id));
    return c.json(await envelope(fresh ?? report, project, state));
  });

  app.post(`${base}/:presentation_id/opening`, async (c) => {
    gate();
    const who = requireUser(c);
    const { body } = await p.validate(c.req, { body: openingBody });
    const { report, project, access } = await popcornReport(ad, who, id(c), "project:update");
    const words = dict(excludeNone(body.patch));
    const patch: Json = {};
    for (const [block, value] of Object.entries(words)) if (truthy(value)) patch[block] = value;
    if (!Object.keys(patch).length) throw new ValidationError("The patch names no opening field.");
    const state = await publishOpening(d, report, patch, (published) =>
      validateDraft(report, access.tier, published),
    );
    return c.json(await envelope(report, project, state));
  });

  app.get(`${base}/:presentation_id/draft/audience`, async (c) => {
    gate();
    const who = requireUser(c);
    const { report, project } = await popcornReport(ad, who, id(c), "project:update");
    const state = await draftState(d.store, report);
    return c.json({
      id: String(report.id),
      manifest: audienceManifest(state.settings),
      bundle: await bundleForReport(d, report, project, {
        host: false,
        settingsOverride: state.settings,
      }),
    });
  });

  app.get(`${base}/:presentation_id/draft/map`, async (c) => {
    gate();
    const who = requireUser(c);
    const { query } = await p.validate(c.req, { query: limits });
    const { report, project } = await popcornReport(ad, who, id(c), "project:update");
    const settings = (await draftState(d.store, report)).settings;
    return c.json(await mapFor(report, project, settings, query));
  });

  app.get(`${base}/projects/:project_id`, async (c) => {
    gate();
    const who = requireUser(c);
    const projectId = c.req.param("project_id");
    const { project } = await projectWith(ad, who, projectId, "project:read");
    let report = await d.store.popcornReport(projectId);
    // A creation that stopped after the report row: this read stays mutation-free and the
    // authorised default POST repairs the config and loop rows.
    if (
      report &&
      (!(await d.store.latestConfig(String(report.id))) ||
        !(await d.store.loopForReport(String(report.id))))
    )
      report = null;
    return c.json({
      presentation: report ? await payload(d, report, project) : null,
      can_edit: await allows(ad, who, projectId, "project:update"),
    });
  });

  app.post(`${base}/projects/:project_id/default`, async (c) => {
    gate();
    const who = requireUser(c);
    const { project } = await projectWith(ad, who, c.req.param("project_id"), "project:update");
    const report = await ensureDefault(d, project, who.directusUserId);
    return c.json(await payload(d, report, project));
  });

  app.post(`${base}/projects/:project_id/start`, async (c) => {
    gate();
    const who = requireUser(c);
    const projectId = c.req.param("project_id");
    const { project } = await projectWith(ad, who, projectId, "project:update");
    const report = await ensureDefault(d, project, who.directusUserId);
    await adoptResults(d, d.map, report, projectId, true);
    const detail = await payload(d, report, project);
    const settings = dict(detail.settings);
    // Ready and valid-empty content is not made again when the screen opens.
    const blocks = audienceManifest(settings).blocks as string[];
    const state = normalizeState((await d.store.loopForReport(String(report.id)))?.popcorn_state);
    const bindings = dict(dict(settings.presentation).result_bindings);
    const analysis = dict(state.analysis);
    const missing = blocks.filter(
      (block) =>
        (block === "popcorn" && !truthy(dict(detail.counts).phrases) && !truthy(state.run)) ||
        ((block === "tensions" || block === "stakeholders") &&
          !truthy(bindings[block]) &&
          !(
            typeof analysis[block] === "object" &&
            analysis[block] !== null &&
            !Array.isArray(analysis[block])
          )) ||
        (block === "map" && !truthy(bindings.map)),
    );
    if (missing.length && (await readiness(d.store, projectId)).conversations)
      for (const block of missing) {
        try {
          await prepareBlock(report, projectId, who.directusUserId, block);
        } catch (err) {
          // A map generation waits for the map port; the screen still opens.
          if (!(err instanceof MapUnavailable)) throw err;
          d.logger.warn({ project: projectId }, "present: map generation not available");
        }
      }
    return c.json(detail);
  });

  app.get(`${base}/:presentation_id/audience`, async (c) => {
    gate();
    const who = requireUser(c);
    const { report, project } = await popcornReport(ad, who, id(c));
    const bundle = await bundleForReport(d, report, project, { host: false });
    const settings = await loadSettingsFor(d.store, report);
    return c.json({ id: String(report.id), manifest: audienceManifest(settings), bundle });
  });

  app.get(`${base}/:presentation_id/map`, async (c) => {
    gate();
    const who = requireUser(c);
    const { query } = await p.validate(c.req, { query: limits });
    const { report, project } = await popcornReport(ad, who, id(c));
    const settings = await loadSettingsFor(d.store, report);
    return c.json(await mapFor(report, project, settings, query));
  });

  // ── the deck pages ─────────────────────────────────────────────────

  const previewQuery = { preview: p.optional(p.bool(), false) };

  app.get(`${base}/:presentation_id/deck/`, async (c) => {
    gate();
    const who = requireUser(c);
    const { query } = await p.validate(c.req, { query: previewQuery });
    // Embed the id the lookup returned, never the raw path value.
    const { report } = await popcornReport(ad, who, id(c));
    return html(renderPopcornPage(deckEmbed(d.adminBaseUrl, String(report.id), query.preview)));
  });

  app.get(`${base}/:presentation_id/draft/deck/`, async (c) => {
    gate();
    const who = requireUser(c);
    const { query } = await p.validate(c.req, { query: previewQuery });
    const { report } = await popcornReport(ad, who, id(c), "project:update");
    return html(renderPopcornPage(deckEmbed(d.adminBaseUrl, String(report.id), query.preview)));
  });

  app.get(`${base}/:presentation_id/deck/data/bundle.json`, async (c) => {
    gate();
    const who = requireUser(c);
    const { report, project } = await popcornReport(ad, who, id(c));
    return c.json(await bundleForReport(d, report, project, { host: false }), 200, NO_STORE);
  });

  app.get(`${base}/:presentation_id/draft/deck/data/bundle.json`, async (c) => {
    gate();
    const who = requireUser(c);
    const { report, project } = await popcornReport(ad, who, id(c), "project:update");
    const settings = (await draftState(d.store, report)).settings;
    return c.json(
      await bundleForReport(d, report, project, { host: false, settingsOverride: settings }),
      200,
      NO_STORE,
    );
  });

  for (const deck of ["deck", "draft/deck"]) {
    app.get(`${base}/:presentation_id/${deck}/events`, async (c) => {
      gate();
      const who = requireUser(c);
      const { report } = await popcornReport(ad, who, id(c));
      return updateStream(c, d.hub, String(report.id));
    });

    app.get(`${base}/:presentation_id/${deck}/logo.png`, async (c) => {
      gate();
      const who = requireUser(c);
      await popcornReport(ad, who, id(c));
      return binary(logoBytes(), "image/png");
    });

    app.get(`${base}/:presentation_id/${deck}/illustrations/:file`, async (c) => {
      gate();
      const who = requireUser(c);
      const name = webpName(c.req.param("file"));
      if (name === null) return c.notFound();
      await popcornReport(ad, who, id(c));
      const bytes = illustrationBytes(name);
      if (!bytes) throw new NotFoundError("Not found");
      return binary(bytes, "image/webp");
    });
  }

  app.post(`${base}/:presentation_id/adopt`, async (c) => {
    gate();
    const who = requireUser(c);
    const { report, project } = await popcornReport(ad, who, id(c), "project:update");
    await adoptResults(d, d.map, report, String(project.id));
    return c.json(await payload(d, report, project));
  });

  app.post(`${base}/:presentation_id/translate`, async (c) => {
    gate();
    const who = requireUser(c);
    const { report, project } = await popcornReport(ad, who, id(c), "project:update");
    const loop = await d.store.loopForReport(String(report.id));
    if (!loop) throw new NotFoundError("Popcorn loop not found");
    // Translation only: no transcripts are read and no analysis runs.
    await dispatchNow(d, String(loop.id), "translation");
    return c.json(await payload(d, report, project), 202);
  });

  app.get(`${base}/:presentation_id/updates`, async (c) => {
    gate();
    const who = requireUser(c);
    const { report, project } = await popcornReport(ad, who, id(c));
    const manifest = dict((await loadSettingsFor(d.store, report)).presentation);
    const available = await availableBindings(d, d.map, report, String(project.id));
    const current = dict(manifest.result_bindings);
    const blocks = Array.isArray(manifest.blocks) ? manifest.blocks : [];
    return c.json({
      available: Object.entries(available).some(
        ([block, identity]) => blocks.includes(block) && identity !== current[block],
      ),
    });
  });

  app.post(`${base}/:presentation_id/prepare/:block`, async (c) => {
    gate();
    const who = requireUser(c);
    const { report, project } = await popcornReport(ad, who, id(c), "project:update");
    const block = c.req.param("block");
    const settings = await loadSettingsFor(d.store, report);
    if (!(audienceManifest(settings).blocks as string[]).includes(block))
      throw new NotFoundError("Activity is not in this presentation.");
    try {
      await prepareBlock(report, String(project.id), who.directusUserId, block);
    } catch (err) {
      // Requesting a map belongs to the map port; until then it answers as an unavailable store.
      if (err instanceof MapUnavailable) throw new UnavailableError("Map storage is unavailable.");
      throw err;
    }
    return c.json({ status: "queued" });
  });

  return app;
}

/** Dict equality as Python compares settings: key order does not count. */
function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted);
  if (v !== null && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sorted((v as Record<string, unknown>)[k])]),
    );
  return v;
}

/** The public /map route's projection: the same audience map, keyed by the share token's report. */
export function publicAudienceMap(deps: PopcornDeps & { map: MapStore }): AudienceMap {
  return async (a) =>
    audienceMap(deps.map, {
      projectId: a.projectId,
      settings: a.settings,
      nodeLimit: a.nodeLimit,
      edgeLimit: a.edgeLimit,
      legend: await conversationLegend(deps.store, a.report),
      excluded: () => deps.deck.excludedObjectIds(a.projectId),
    });
}
