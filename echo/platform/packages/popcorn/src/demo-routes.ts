import { hasStaffPolicy, requireStaff, type StaffAudit } from "@echo/access";
import { ForbiddenError } from "@echo/core";
import type { Db } from "@echo/db";
import { type Env, requireUser } from "@echo/http";
import { p } from "@echo/legacy-shape";
import { Hono } from "hono";
import { corpusFrom, refuseProduction, seedDemo } from "./demo";
import { dict, type Json } from "./py";

export interface DemoRoutesDeps {
  readonly db: Db;
  readonly staffAudit: StaffAudit;
  /** This deployment's own addresses, refused like the seed's arguments when they are production. */
  readonly ownUrls: readonly string[];
  readonly now?: () => Date;
}

const { model, required, optional, str, bool, dict: dictType, list, any } = p;

const demoBody = model({
  session: required(dictType()),
  research: required(str()),
  corpus: required(list(any())),
  out: required(dictType()),
  sales_portal: required(dictType()),
  workspace_id: required(str()),
  owner_id: required(str()),
  portal_base_url: required(str()),
  api_base_url: required(str()),
  dry_run: optional(bool(), false),
});

/**
 * POST /api/v2/admin/popcorn/demos: staff seed a reviewed synthetic demo into this
 * environment and get its public links back, the same rows and links seed_demo.py made
 * through Directus. sam's popcorn-demo skill calls it through `seed_demo.py --platform`.
 * Staff only (staff:workspaces, audited), never on production.
 */
export function popcornDemoRoutes(deps: DemoRoutesDeps) {
  const now = deps.now ?? (() => new Date());
  return new Hono<Env>().post("/api/v2/admin/popcorn/demos", async (c) => {
    const who = requireUser(c);
    // Refused before the body is read: nothing about the request reaches a non-staff caller.
    if (!hasStaffPolicy(who, "staff:workspaces")) throw new ForbiddenError("Staff-only");
    const { body } = await p.validate(c.req, { body: demoBody });
    const b = body.data;
    refuseProduction([...deps.ownUrls, b.portal_base_url, b.api_base_url]);
    await requireStaff(deps.staffAudit, who, {
      permission: "staff:workspaces",
      action: "popcorn.demo.seed",
      targetType: "workspace",
      targetId: b.workspace_id,
      detail: { slug: dict(b.session).slug ?? null, dry_run: b.dry_run },
      requestId: c.get("requestId"),
    });
    const out: Record<string, { state: Json; settings: Json }> = {};
    for (const [language, files] of Object.entries(b.out)) {
      const f = dict(files);
      out[language] = { state: dict(f.state), settings: dict(f.settings) };
    }
    const seeded = await seedDemo(
      deps.db,
      {
        session: b.session,
        research: b.research,
        corpus: corpusFrom(b.corpus),
        out,
        salesPortal: Object.fromEntries(
          Object.entries(b.sales_portal).map(([k, v]) => [k, dict(v)]),
        ),
        workspaceId: b.workspace_id,
        ownerId: b.owner_id,
        portalBaseUrl: b.portal_base_url,
        apiBaseUrl: b.api_base_url,
        dryRun: b.dry_run,
      },
      now(),
    );
    return c.json(
      b.dry_run ? { ...seeded.result, dry_run: true, plan: seeded.plan } : seeded.result,
    );
  });
}
