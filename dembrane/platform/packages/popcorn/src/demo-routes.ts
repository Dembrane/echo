import { hasStaffPolicy, requireStaff, type StaffAudit } from "@dembrane/access";
import { ForbiddenError } from "@dembrane/core";
import type { Db } from "@dembrane/db";
import { type Env, requireUser, type Signed } from "@dembrane/http";
import { p } from "@dembrane/legacy-shape";
import { Hono } from "hono";
import { corpusFrom, refuseProduction, seedDemo } from "./demo";
import { dict, type Json } from "./py";

export interface DemoRoutesDeps {
  readonly db: Db;
  readonly staffAudit: StaffAudit;
  /** This deployment's own addresses, refused like the seed's arguments when they are production. */
  readonly ownUrls: readonly string[];
  readonly now?: () => Date;
  /**
   * Creates the prospect's organisation when the request carries a `prospect` block
   * (@dembrane/accounts provides it). Returns what the response reports and where the public
   * page's "Continue in dembrane" leads. Absent, a prospect block is refused.
   */
  readonly prospect?: ProspectHook;
}

export type ProspectHook = (
  who: Signed,
  block: Json,
  opts: { slug: string; requestId: string; dryRun: boolean },
) => Promise<{
  continueUrl: string | null;
  result: Json;
  /** Runs after the demo is seeded, with the links it printed (the account's timeline). */
  afterSeed?: (seeded: Json) => Promise<void>;
}>;

const { model, required, optional, nullable, str, bool, dict: dictType, list, any } = p;

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
  prospect: optional(nullable(dictType()), null),
});

/**
 * POST /api/v2/admin/popcorn/demos: staff seed a reviewed synthetic demo into this
 * environment and get its public links back, the same rows and links the Python
 * seed_demo.py made through Directus. sam calls it with a staff token.
 * Staff only (staff:workspaces, audited), never on production.
 */
export function popcornDemoRoutes(deps: DemoRoutesDeps) {
  const now = deps.now ?? (() => new Date());
  return new Hono<Env>().post("/api/v2/admin/popcorn/demos", async (c) => {
    const who = requireUser(c);
    // Refused before the body is read: nothing about the request reaches a non-staff caller.
    if (!hasStaffPolicy(who, "staff:workspaces")) throw new ForbiddenError("access.staff_only");
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
    let prospect: Awaited<ReturnType<ProspectHook>> | null = null;
    if (b.prospect) {
      if (!deps.prospect) throw new ForbiddenError("popcorn.demo_prospect_unavailable");
      prospect = await deps.prospect(who, b.prospect, {
        slug: String(dict(b.session).slug ?? ""),
        requestId: c.get("requestId"),
        dryRun: b.dry_run,
      });
    }
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
        ...(prospect?.continueUrl && { continueUrl: prospect.continueUrl }),
      },
      now(),
    );
    if (prospect?.afterSeed && !b.dry_run) await prospect.afterSeed(seeded.result);
    const result = prospect ? { ...seeded.result, prospect: prospect.result } : seeded.result;
    return c.json(b.dry_run ? { ...result, dry_run: true, plan: seeded.plan } : result);
  });
}
