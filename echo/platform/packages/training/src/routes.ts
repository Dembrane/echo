import { requireStaff, type StaffAudit } from "@echo/access";
import { type Billing, isUuid } from "@echo/billing";
import { ForbiddenError } from "@echo/core";
import type { Db } from "@echo/db";
import { type Ctx, type Env, type Field, rawRequest, requireUser, v, validate } from "@echo/http";
import type { Mailer } from "@echo/mail";
import type { Logger } from "@echo/observability";
import { Hono } from "hono";
import {
  catalog,
  completeTraining,
  createTraining,
  listTrainings,
  myLicenses,
  orgRoster,
  requestTraining,
  revokeLicense,
  staffOrgRoster,
  type TrainingDeps,
  trainingLicenses,
  updateLicense,
  updateTraining,
} from "./service";
import { trainingStorage } from "./storage";

export interface TrainingRouteDeps {
  readonly db: Db;
  readonly staffAudit: StaffAudit;
  readonly billing: Billing;
  readonly mailer: Mailer;
  readonly logger: Logger;
  readonly config: { readonly http: { readonly dashboardUrl: string } };
  readonly clock?: () => Date;
}

/** pydantic `list[str] = Field(min_length=1)`. */
const nonEmptyStrList: Field<string[]> = {
  required: true,
  parse(input, loc) {
    const base = v.strList().parse(input, loc, "body");
    if (!base.ok) return base;
    if (base.value.length < 1)
      return {
        ok: false,
        errors: [
          {
            type: "too_short",
            loc,
            msg: "List should have at least 1 item after validation, not 0",
            input,
            ctx: { field_type: "List", min_length: 1, actual_length: 0 },
            url: "https://errors.pydantic.dev/2.12/v/too_short",
          },
        ],
      };
    return base;
  },
};

/** pydantic `float = Field(ge=0)`, optional: a number at or above zero, or null. */
const nonNegativeNumber: Field<number | null> = {
  required: false,
  fallback: () => null,
  parse(input, loc, where) {
    if (input === null) return { ok: true, value: null };
    const base = v.num().parse(input, loc, where);
    if (!base.ok || base.value >= 0) return base;
    return {
      ok: false,
      errors: [
        {
          type: "greater_than_equal",
          loc,
          msg: "Input should be greater than or equal to 0",
          input,
          ctx: { ge: 0 },
          url: "https://errors.pydantic.dev/2.12/v/greater_than_equal",
        },
      ],
    };
  },
};

const TYPES = ["online", "in_person", "flex"] as const;

/**
 * Training (its own product, separate from tiers): the catalog, an org's roster, org
 * admins requesting a training, one's own licences; and the staff surface to provision,
 * complete and revoke, gated on staff:training and audited.
 */
export function trainingRoutes(deps: TrainingRouteDeps) {
  const d: TrainingDeps = {
    store: trainingStorage(deps.db),
    notifier: deps.billing.notifier,
    mailer: deps.mailer,
    logger: deps.logger,
    dashboardUrl: deps.config.http.dashboardUrl,
    clock: deps.clock ?? (() => new Date()),
  };

  /** The old get_app_user_or_raise: v2 routes need an onboarded user. */
  function onboarded(c: Ctx) {
    const who = requireUser(c);
    if (!who.appUserId) throw new ForbiddenError("User not onboarded");
    return { ...who, appUserId: who.appUserId };
  }

  async function staff(c: Ctx, action: string, targetType?: string, targetId?: string) {
    const who = requireUser(c);
    await requireStaff(deps.staffAudit, who, {
      permission: "staff:training",
      action,
      ...(targetType && { targetType }),
      ...(targetId && { targetId }),
      requestId: c.get("requestId"),
    });
    return who;
  }

  const idOrNull = (s: string | undefined) => (isUuid(s) ? s : null);

  return new Hono<Env>()
    .get("/api/v2/training/catalog", (c) => {
      requireUser(c);
      return c.json(catalog());
    })
    .get("/api/v2/training/orgs/:org_id/roster", async (c) => {
      const who = onboarded(c);
      const orgId = c.req.param("org_id");
      if (!isUuid(orgId)) throw new ForbiddenError("No access to this organisation");
      return c.json(await orgRoster(d, orgId, who.appUserId));
    })
    .post("/api/v2/training/orgs/:org_id/request", async (c) => {
      const raw = await rawRequest(c.req);
      requireUser(c);
      const { body } = validate(raw, {
        body: {
          type: v.literal(["online", "in_person"]),
          extra_participants: v.int({ ge: 0, le: 500 }).default(0),
          notes: v.str({ max: 2000 }).optional(),
        },
      });
      const who = onboarded(c);
      const orgId = c.req.param("org_id");
      if (!isUuid(orgId)) throw new ForbiddenError("No access to this organisation");
      return c.json(await requestTraining(d, orgId, { id: who.appUserId }, body));
    })
    .get("/api/v2/training/licenses/me", async (c) => {
      const who = onboarded(c);
      return c.json(await myLicenses(d, who.appUserId));
    })
    .get("/api/v2/admin/trainings", async (c) => {
      const raw = await rawRequest(c.req);
      requireUser(c);
      const { query } = validate(raw, {
        query: { org_id: v.str().optional(), status: v.str().optional() },
      });
      await staff(c, "training.list");
      // A filter value that cannot match the column matches nothing.
      if (query.org_id && !isUuid(query.org_id)) return c.json([]);
      return c.json(
        await listTrainings(d, {
          ...(query.org_id && { orgId: query.org_id }),
          ...(query.status && { status: query.status }),
        }),
      );
    })
    .post("/api/v2/admin/trainings", async (c) => {
      const raw = await rawRequest(c.req);
      requireUser(c);
      const { body } = validate(raw, {
        body: {
          org_id: v.str(),
          type: v.literal(TYPES),
          extra_participants: v.int({ ge: 0, le: 500 }).default(0),
          scheduled_at: v.str().optional(),
          notes: v.str({ max: 2000 }).optional(),
          base_price_eur: nonNegativeNumber,
        },
      });
      const who = await staff(c, "training.create", "org", body.org_id);
      if (!who.appUserId) throw new ForbiddenError("User not onboarded");
      return c.json(await createTraining(d, body, isUuid(body.org_id)));
    })
    .patch("/api/v2/admin/trainings/:training_id", async (c) => {
      const raw = await rawRequest(c.req);
      requireUser(c);
      const { body } = validate(raw, {
        body: {
          type: v.literal(TYPES).optional(),
          status: v.literal(["requested", "scheduled", "completed", "cancelled"]).optional(),
          scheduled_at: v.str().optional(),
          extra_participants: v.int({ ge: 0, le: 500 }).optional(),
          notes: v.str({ max: 2000 }).optional(),
        },
      });
      const id = c.req.param("training_id");
      await staff(c, "training.update", "training", id);
      return c.json(await updateTraining(d, idOrNull(id), body));
    })
    .get("/api/v2/admin/trainings/orgs/:org_id/roster", async (c) => {
      const orgId = c.req.param("org_id");
      await staff(c, "training.roster.read", "org", orgId);
      if (!isUuid(orgId))
        return c.json({ org_id: orgId, trained_count: 0, total_count: 0, members: [] });
      return c.json(await staffOrgRoster(d, orgId));
    })
    .get("/api/v2/admin/trainings/:training_id/licenses", async (c) => {
      const id = c.req.param("training_id");
      await staff(c, "training.licenses.read", "training", id);
      return c.json(await trainingLicenses(d, idOrNull(id)));
    })
    .post("/api/v2/admin/trainings/:training_id/complete", async (c) => {
      const raw = await rawRequest(c.req);
      requireUser(c);
      const { body } = validate(raw, {
        body: { app_user_ids: nonEmptyStrList, completed_at: v.str().optional() },
      });
      const id = c.req.param("training_id");
      const who = await staff(c, "training.complete", "training", id);
      if (!who.appUserId) throw new ForbiddenError("User not onboarded");
      return c.json(await completeTraining(d, idOrNull(id), who.appUserId, body));
    })
    .patch("/api/v2/admin/licenses/:license_id", async (c) => {
      const raw = await rawRequest(c.req);
      requireUser(c);
      const { body } = validate(raw, {
        body: {
          completed_at: v.str().optional(),
          status: v.literal(["active", "expired", "revoked"]).optional(),
        },
      });
      const id = c.req.param("license_id");
      await staff(c, "training_license.update", "training_license", id);
      return c.json(await updateLicense(d, idOrNull(id), body));
    })
    .post("/api/v2/admin/licenses/:license_id/revoke", async (c) => {
      const id = c.req.param("license_id");
      await staff(c, "training_license.revoke", "training_license", id);
      return c.json(await revokeLicense(d, idOrNull(id)));
    });
}
