import { timingSafeEqual } from "node:crypto";
import { requireStaff, type StaffAudit } from "@dembrane/access";
import { BadRequestError, PlatformError, StatusError, ValidationError } from "@dembrane/core";
import type { Db } from "@dembrane/db";
import { type Ctx, type Env, requireUser, v } from "@dembrane/http";
import type { Logger } from "@dembrane/observability";
import type { Limit, RateLimiter } from "@dembrane/ratelimit";
import type { ObjectStorage } from "@dembrane/storage";
import { Hono } from "hono";
import {
  APP_PREFIX,
  type Attachment,
  cleanEmail,
  INTERNAL_EMAIL_DOMAIN,
  type PricingPayload,
  SITE_PREFIX,
  upsertConfiguration,
} from "./service";
import { type PricingStore, pricingStorage } from "./storage";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 6;

export interface PricingRouteDeps {
  readonly db: Db;
  readonly storage: ObjectStorage;
  readonly logger: Logger;
  /** The website's shared token; unset closes the site route. */
  readonly siteToken: string | null;
  readonly limiter: RateLimiter;
  /** Records each staff read of the enquiry list. */
  readonly staffAudit: StaffAudit;
  /** Test seam; defaults to Postgres. */
  readonly store?: PricingStore;
}

const s255 = () => v.str({ max: 255 });
const SHAPE = {
  config_session_id: v.str({ min: 1, max: 255 }),
  question_set_version: v.withDefault(s255(), ""),
  config_shape_version: v.optional(v.int()),
  mount: v.withDefault(v.literal(["app", "site"]), "app"),
  locale: v.withDefault(s255(), ""),
  wall_key: v.optional(s255()),
  workspace_id: v.optional(s255()),
  org_id: v.optional(s255()),
  project_id: v.optional(s255()),
  answers_raw: v.withDefault(v.dict(), {}),
  config: v.withDefault(v.dict(), {}),
  status: v.withDefault(v.literal(["in_progress", "submitted"]), "in_progress"),
  booking_uid: v.optional(s255()),
  booking_status: v.optional(s255()),
  booking_start: v.optional(s255()),
};

/**
 * pydantic model_validate inside the handler: the same errors as a body model, but
 * the location has no "body" prefix and there is no docs url.
 */
function validatePayload<E extends v.Shape>(body: Record<string, unknown>, extra: E) {
  try {
    return v.validateRaw(
      { query: {}, body: JSON.stringify(body) },
      { body: { ...SHAPE, ...extra } },
    ).body;
  } catch (e) {
    if (!(e instanceof ValidationError)) throw e;
    const errors = (e.details as unknown as v.Issue[]).map(({ url: _url, loc, ...rest }) => ({
      ...rest,
      loc: loc.slice(1),
    }));
    throw new ValidationError("validation.invalid_input", { details: errors, params: e.params });
  }
}

/** The JSON payload and any recordings that travelled with it (multipart after a failed transcription). */
async function readBody(c: Ctx, logger: Logger): Promise<[Record<string, unknown>, Attachment[]]> {
  const type = (c.req.header("content-type") ?? "").toLowerCase();
  if (!type.startsWith("multipart/form-data")) {
    let body: unknown;
    try {
      body = JSON.parse(await c.req.text());
    } catch {
      throw new BadRequestError("request.invalid_json");
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new BadRequestError("pricing.body_not_object");
    return [body as Record<string, unknown>, []];
  }
  const form = await c.req.formData();
  const raw = form.get("payload");
  if (typeof raw !== "string") throw new BadRequestError("pricing.payload_missing");
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new BadRequestError("pricing.payload_invalid_json");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new BadRequestError("pricing.payload_not_object");
  const attachments: Attachment[] = [];
  for (const [key, value] of form.entries()) {
    if (!key.startsWith("audio_") || key.endsWith("_duration_ms")) continue;
    if (typeof value === "string") {
      logger.warn({ key }, "pricing configuration: audio part arrived as text, skipped");
      continue;
    }
    if (attachments.length >= MAX_ATTACHMENTS) {
      logger.warn("pricing configuration: more than six recordings, rest dropped");
      break;
    }
    const file = value as unknown as File;
    const questionKey = key.slice("audio_".length);
    let content = new Uint8Array(await file.arrayBuffer());
    if (content.byteLength > MAX_AUDIO_BYTES) content = new Uint8Array();
    const d = form.get(`audio_${questionKey}_duration_ms`);
    const durationMs = typeof d === "string" && /^\d+$/.test(d.trim()) ? Number(d.trim()) : null;
    attachments.push({
      questionKey,
      filename: file.name || `${questionKey}.webm`,
      contentType: file.type || "audio/webm",
      durationMs,
      content,
    });
  }
  return [body as Record<string, unknown>, attachments];
}

function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** POST /api/v2/pricing-configurations (session) and /site (website token). */
/** 120 writes an hour per user (app) and per visitor (site), as the old limiter allowed. */
export const PRICING_LIMITS: { readonly app: Limit; readonly site: Limit } = {
  app: { name: "pricing.app", capacity: 120, windowSeconds: 3600 },
  site: { name: "pricing.site", capacity: 120, windowSeconds: 3600 },
};

/** The columns sam's pricing digest reads, as it read them from the database. */
const ENQUIRY_FIELDS = [
  "reference",
  "email",
  "status",
  "booking_uid",
  "booking_status",
  "config",
  "answers_raw",
  "created_at",
  "updated_at",
] as const;

export function pricingRoutes(deps: PricingRouteDeps) {
  const store = deps.store ?? pricingStorage(deps.db);
  const upsertDeps = { store, storage: deps.storage, logger: deps.logger };
  return (
    new Hono<Env>()
      /**
       * External enquiries that moved in the last `days` (default 7): the source of sam's daily
       * pricing digest, which read pricing_configuration straight from the old database.
       * sam calls it with its staff key; each read is audited.
       */
      .get("/api/v2/admin/pricing-configurations", async (c) => {
        const who = requireUser(c);
        const raw = await v.rawRequest(c.req);
        const { query } = v.validateRaw(raw, {
          query: { days: v.withDefault(v.int({ ge: 1, le: 31 }), 7) },
        });
        await requireStaff(deps.staffAudit, who, {
          permission: "staff:accounts",
          action: "admin.pricing_configurations.read",
          detail: { days: query.days },
          requestId: c.get("requestId"),
        });
        const since = new Date(Date.now() - query.days * 86_400_000);
        const rows = await store.recentEnquiries(since);
        return c.json(rows.map((r) => Object.fromEntries(ENQUIRY_FIELDS.map((k) => [k, r[k]]))));
      })
      .post("/api/v2/pricing-configurations", async (c) => {
        const who = requireUser(c);
        await deps.limiter.checkUser(PRICING_LIMITS.app, who.directusUserId);
        const [body, attachments] = await readBody(c, deps.logger);
        const payload = validatePayload(body, {});
        const email =
          ((await store.directusEmail(who.directusUserId)) ?? "").trim().toLowerCase() || null;
        if (!email) deps.logger.warn("pricing configuration: no email on the directus user");
        return c.json(
          await upsertConfiguration(upsertDeps, payload as PricingPayload, attachments, {
            email,
            userId: who.directusUserId,
            isInternal: Boolean(email?.endsWith(INTERNAL_EMAIL_DOMAIN)),
            prefix: APP_PREFIX,
          }),
        );
      })
      .post("/api/v2/pricing-configurations/site", async (c) => {
        if (!deps.siteToken) throw new StatusError(503, "pricing.site_not_configured");
        if (!tokenMatches(c.req.header("x-site-token") ?? "", deps.siteToken))
          throw new StatusError(401, "pricing.site_token_invalid");
        // Per visitor as the site's function reports it (spec 7 L-20 keeps trusting it).
        await deps.limiter.check(
          PRICING_LIMITS.site,
          (c.req.header("x-site-visitor-ip") ?? "").trim() || "unknown",
        );
        const [body] = await readBody(c, deps.logger);
        const payload = validatePayload(body, { email: v.optional(s255()) });
        // Whatever the body said, this row came from the site.
        const email = cleanEmail(payload.email as string | null);
        return c.json(
          await upsertConfiguration(
            upsertDeps,
            { ...(payload as PricingPayload), mount: "site" },
            [],
            {
              email,
              userId: null,
              isInternal: Boolean(email?.endsWith(INTERNAL_EMAIL_DOMAIN)),
              prefix: SITE_PREFIX,
            },
          ),
        );
      })
  );
}
