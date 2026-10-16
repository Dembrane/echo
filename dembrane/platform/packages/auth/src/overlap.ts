import { newId } from "@dembrane/core";
import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { and, eq, gt, isNull, ne, notLike, or } from "drizzle-orm";
import { z } from "zod";
import { browserDetails } from "./device";

// Two browsers per account. A sign-in from a third browser gets a held session, which signs
// nobody in until the person chooses one other browser to sign out. Every
// such sign-in is kept in auth_sign_in_overlap and reported to onOverlap.

/** The dashboard names its browser in this header on every auth call. */
export const DEVICE_ID_HEADER = "x-device-id";

// Staff API keys are sessions too (accounts/staff-key.ts). They are never another browser
// and are never replaced.
const STAFF_KEY_AGENT = "staff-api-key:%";
const MAX_DEVICES = 2;

export interface Overlap {
  readonly userId: string;
  readonly sessionId: string;
  readonly deviceId: string | null;
  /** "held" when the sign-in met other sessions, "replaced" when the person went ahead. */
  readonly outcome: "held" | "replaced";
  readonly otherSessions: number;
  readonly otherDevices: number;
  /** When any of the other sessions last made a request. */
  readonly otherLastSeenAt: Date | null;
}

export type OnOverlap = (overlap: Overlap) => void;

/** The id a browser sent, or null when the caller is not the dashboard or sent junk. */
export function deviceIdFrom(headers: Headers | null | undefined): string | null {
  const id = headers?.get(DEVICE_ID_HEADER)?.trim();
  return id && /^[A-Za-z0-9-]{8,64}$/.test(id) ? id : null;
}

interface Other {
  readonly id: string;
  readonly deviceId: string | null;
  readonly seenAt: Date;
  readonly createdAt: Date;
  readonly userAgent: string | null;
}

/**
 * The user's signed-in sessions on other browsers. A session with no device id (signed in
 * before this existed, or by a client that is not the dashboard) counts as another browser.
 */
async function othersOf(
  db: Pick<Db, "select">,
  userId: string,
  deviceId: string,
  exceptSessionId?: string,
): Promise<Other[]> {
  const s = schema.auth_session;
  const rows = await db
    .select({
      id: s.id,
      deviceId: s.deviceId,
      lastSeenAt: s.lastSeenAt,
      updatedAt: s.updatedAt,
      createdAt: s.createdAt,
      userAgent: s.userAgent,
    })
    .from(s)
    .where(
      and(
        eq(s.userId, userId),
        eq(s.held, false),
        gt(s.expiresAt, new Date()),
        or(isNull(s.deviceId), ne(s.deviceId, deviceId)),
        or(isNull(s.userAgent), notLike(s.userAgent, STAFF_KEY_AGENT)),
        ...(exceptSessionId ? [ne(s.id, exceptSessionId)] : []),
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    deviceId: r.deviceId,
    seenAt: r.lastSeenAt ?? r.updatedAt,
    createdAt: r.createdAt,
    userAgent: r.userAgent,
  }));
}

/** One selector per device; the session id is not its secret bearer token. */
function devicesOf(others: readonly Other[]) {
  const devices = new Map<string, Other>();
  for (const other of others) {
    const key = other.deviceId ?? "";
    const previous = devices.get(key);
    if (!previous || other.seenAt > previous.seenAt) devices.set(key, other);
  }
  return [...devices.values()]
    .sort((a, b) => b.seenAt.getTime() - a.seenAt.getTime() || a.id.localeCompare(b.id))
    .map((other) => ({
      id: other.id,
      ...browserDetails(other.deviceId ? other.userAgent : null),
      lastActiveAt: other.seenAt.toISOString(),
    }));
}

function summary(others: readonly Other[]) {
  const latest = others.reduce<Date | null>(
    (max, o) => (!max || o.seenAt > max ? o.seenAt : max),
    null,
  );
  return {
    otherSessions: others.length,
    // Sessions without a device id cannot be told apart, so together they count as one.
    otherDevices: new Set(others.map((o) => o.deviceId ?? "")).size,
    otherLastSeenAt: latest,
  };
}

/**
 * What a new session carries: its device id, and held when the user is signed in on
 * two other browsers. Callers that send no device id (API clients, scripts) are never held.
 */
export async function holdFor(
  db: Pick<Db, "select">,
  userId: string,
  headers: Headers | null | undefined,
): Promise<{ deviceId: string | null; held: boolean }> {
  const deviceId = deviceIdFrom(headers);
  if (!deviceId) return { deviceId: null, held: false };
  const others = await othersOf(db, userId, deviceId);
  return { deviceId, held: summary(others).otherDevices >= MAX_DEVICES };
}

/** Keeps the overlap a held session was created with, and reports it. */
export async function recordHeld(
  db: Db,
  session: { id: string; userId: string; deviceId: string },
  onOverlap?: OnOverlap,
): Promise<void> {
  const counts = summary(await othersOf(db, session.userId, session.deviceId, session.id));
  await db.insert(schema.auth_sign_in_overlap).values({
    id: newId(),
    userId: session.userId,
    sessionId: session.id,
    deviceId: session.deviceId,
    ...counts,
  });
  onOverlap?.({
    userId: session.userId,
    sessionId: session.id,
    deviceId: session.deviceId,
    outcome: "held",
    ...counts,
  });
}

/**
 * The two calls the login page makes after a sign-in:
 * GET /other-sessions lists the active devices while a sign-in is held. Only recognisable
 * browser/platform names and last-active times are returned, never tokens, addresses or IPs.
 * POST /other-sessions/replace-device signs out the selected device and releases the hold.
 */
export function oneBrowser(opts: { db: Db; onOverlap?: OnOverlap | undefined }) {
  const { db } = opts;
  const s = schema.auth_session;
  return {
    id: "one-browser",
    endpoints: {
      otherSessions: createAuthEndpoint("/other-sessions", { method: "GET" }, async (ctx) => {
        const found = await getSessionFromCtx(ctx);
        if (!found) throw new APIError("UNAUTHORIZED");
        const state = await db.transaction(async (tx) => {
          // The same account lock as session creation and replacement: a session can
          // expire or sign out while this person is looking at the choice.
          await tx
            .select({ id: schema.auth_user.id })
            .from(schema.auth_user)
            .where(eq(schema.auth_user.id, found.user.id))
            .for("update");
          const [row] = await tx
            .select({ held: s.held, deviceId: s.deviceId })
            .from(s)
            .where(and(eq(s.id, found.session.id), eq(s.userId, found.user.id)))
            .limit(1);
          if (!row) throw new APIError("UNAUTHORIZED");
          if (!row.held) return { held: false, since: null, devices: [] };
          const others = await othersOf(tx, found.user.id, row.deviceId ?? "", found.session.id);
          // A slot is already free. No other device needs to be signed out.
          if (summary(others).otherDevices < MAX_DEVICES) {
            await tx
              .update(s)
              .set({ held: false, lastSeenAt: new Date() })
              .where(eq(s.id, found.session.id));
            return { held: false, since: null, devices: [] };
          }
          const latest = others.reduce<Date | null>(
            (max, other) => (!max || other.createdAt > max ? other.createdAt : max),
            null,
          );
          return { held: true, since: latest?.toISOString() ?? null, devices: devicesOf(others) };
        });
        return ctx.json(state);
      }),
      replaceOtherDevice: createAuthEndpoint(
        "/other-sessions/replace-device",
        { method: "POST", body: z.object({ sessionId: z.string().min(1).max(128).optional() }) },
        async (ctx) => {
          const found = await getSessionFromCtx(ctx);
          if (!found) throw new APIError("UNAUTHORIZED");
          const sessionId = found.session.id;
          const userId = found.user.id;
          const now = new Date();
          const result = await db.transaction(async (tx) => {
            await tx
              .select({ id: schema.auth_user.id })
              .from(schema.auth_user)
              .where(eq(schema.auth_user.id, userId))
              .for("update");
            const [row] = await tx
              .select({ held: s.held, deviceId: s.deviceId })
              .from(s)
              .where(and(eq(s.id, sessionId), eq(s.userId, userId)))
              .limit(1);
            if (!row) throw new APIError("UNAUTHORIZED");
            if (!row.held) return null;
            const others = await othersOf(tx, userId, row.deviceId ?? "", sessionId);
            let replaced = 0;
            if (summary(others).otherDevices >= MAX_DEVICES) {
              if (!ctx.body.sessionId)
                throw new APIError("BAD_REQUEST", { message: "Choose a device to sign out" });
              const chosen = others.find((other) => other.id === ctx.body.sessionId);
              // Never accept another person's session, a staff key or a held session.
              if (!chosen)
                throw new APIError("CONFLICT", {
                  message: "This device is no longer available. Choose again.",
                });
              const remaining = others.filter((other) => other.deviceId !== chosen.deviceId);
              if (summary(remaining).otherDevices >= MAX_DEVICES)
                throw new APIError("CONFLICT", {
                  message: "The active devices changed. Choose again.",
                });
              // A browser may have several sessions. Revoke that whole device only,
              // preserving every other browser and all staff API keys.
              const deleted = await tx
                .delete(s)
                .where(
                  and(
                    eq(s.userId, userId),
                    ne(s.id, sessionId),
                    chosen.deviceId === null ? isNull(s.deviceId) : eq(s.deviceId, chosen.deviceId),
                    or(isNull(s.userAgent), notLike(s.userAgent, STAFF_KEY_AGENT)),
                  ),
                )
                .returning({ id: s.id });
              replaced = deleted.length;
            }
            await tx.update(s).set({ held: false, lastSeenAt: now }).where(eq(s.id, sessionId));
            await tx
              .update(schema.auth_sign_in_overlap)
              .set({ replacedAt: now })
              .where(eq(schema.auth_sign_in_overlap.sessionId, sessionId));
            return { replaced, deviceId: row.deviceId, counts: summary(others) };
          });
          if (result)
            opts.onOverlap?.({
              userId,
              sessionId,
              deviceId: result.deviceId,
              outcome: "replaced",
              ...result.counts,
            });
          return ctx.json({ replaced: result?.replaced ?? 0 });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
