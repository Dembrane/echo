import { timingSafeEqual } from "node:crypto";
import { BadRequestError, PlatformError, ValidationError } from "@echo/core";
import type { Db } from "@echo/db";
import {
  type Ctx,
  type Env,
  type Field,
  type PydanticError,
  RateLimiter,
  requireUser,
  v,
  validate,
} from "@echo/http";
import type { Logger } from "@echo/observability";
import type { ObjectStorage } from "@echo/storage";
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
  /** Test seam; defaults to Postgres. */
  readonly store?: PricingStore;
}

class Unconfigured extends PlatformError {
  readonly status = 503;
  readonly code = "unavailable";
}
class InvalidToken extends PlatformError {
  readonly status = 401;
  readonly code = "unauthenticated";
}

const s255 = () => v.str({ max: 255 });
const SHAPE = {
  config_session_id: v.str({ min: 1, max: 255 }),
  question_set_version: s255().default(""),
  config_shape_version: v.int().optional(),
  mount: v.literal(["app", "site"]).default("app"),
  locale: s255().default(""),
  wall_key: s255().optional(),
  workspace_id: s255().optional(),
  org_id: s255().optional(),
  project_id: s255().optional(),
  answers_raw: v.dict().default({}),
  config: v.dict().default({}),
  status: v.literal(["in_progress", "submitted"]).default("in_progress"),
  booking_uid: s255().optional(),
  booking_status: s255().optional(),
  booking_start: s255().optional(),
};

/**
 * pydantic model_validate inside the handler: the same errors as a body model, but
 * the location has no "body" prefix and there is no docs url.
 */
function validatePayload<E extends Record<string, Field<unknown>>>(
  body: Record<string, unknown>,
  extra: E,
) {
  try {
    return validate({ query: {}, body: JSON.stringify(body) }, { body: { ...SHAPE, ...extra } })
      .body;
  } catch (e) {
    if (!(e instanceof ValidationError)) throw e;
    const errors = (e.details as unknown as PydanticError[]).map(({ url: _url, loc, ...rest }) => ({
      ...rest,
      loc: loc.slice(1),
    }));
    throw new ValidationError(e.message, errors as unknown as Record<string, unknown>);
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
      throw new BadRequestError("Body is not valid JSON");
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new BadRequestError("Body must be a JSON object");
    return [body as Record<string, unknown>, []];
  }
  const form = await c.req.formData();
  const raw = form.get("payload");
  if (typeof raw !== "string")
    throw new BadRequestError("Multipart body needs a `payload` part holding the JSON");
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new BadRequestError("`payload` is not valid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new BadRequestError("`payload` must be a JSON object");
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
export function pricingRoutes(
  deps: PricingRouteDeps,
  limits = { app: new RateLimiter(120, 3600), site: new RateLimiter(120, 3600) },
) {
  const store = deps.store ?? pricingStorage(deps.db);
  const upsertDeps = { store, storage: deps.storage, logger: deps.logger };
  return new Hono<Env>()
    .post("/api/v2/pricing-configurations", async (c) => {
      const who = requireUser(c);
      limits.app.checkUser(who.directusUserId);
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
      if (!deps.siteToken) throw new Unconfigured("Site writes are not configured");
      if (!tokenMatches(c.req.header("x-site-token") ?? "", deps.siteToken))
        throw new InvalidToken("Invalid site token");
      // Per visitor as the site's function reports it (spec 7 L-20 keeps trusting it).
      limits.site.check((c.req.header("x-site-visitor-ip") ?? "").trim() || "unknown");
      const [body] = await readBody(c, deps.logger);
      const payload = validatePayload(body, { email: s255().optional() });
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
    });
}
