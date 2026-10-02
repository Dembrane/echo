import { newId } from "@dembrane/core";
import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { and, desc, eq, gt, isNull, ne, notLike, or } from "drizzle-orm";

// One browser per account. A sign-in from a second browser gets a held session, which signs
// nobody in until the person chooses to replace the sessions on their other browsers. Every
// such sign-in is kept in auth_sign_in_overlap and reported to onOverlap.

/** The dashboard names its browser in this header on every auth call. */
export const DEVICE_ID_HEADER = "x-device-id";

// Staff API keys are sessions too (accounts/staff-key.ts). They are never another browser
// and are never replaced.
const STAFF_KEY_AGENT = "staff-api-key:%";

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
}

/**
 * The user's signed-in sessions on other browsers. A session with no device id (signed in
 * before this existed, or by a client that is not the dashboard) counts as another browser.
 */
async function othersOf(
  db: Db,
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
 * another browser. Callers that send no device id (API clients, scripts) are never held.
 */
export async function holdFor(
  db: Db,
  userId: string,
  headers: Headers | null | undefined,
): Promise<{ deviceId: string | null; held: boolean }> {
  const deviceId = deviceIdFrom(headers);
  if (!deviceId) return { deviceId: null, held: false };
  const others = await othersOf(db, userId, deviceId);
  return { deviceId, held: others.length > 0 };
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
 * GET /other-sessions says whether the session is held and since when the account has
 * been signed in elsewhere (a time only: never an address, place or browser);
 * POST /other-sessions/replace signs the other browsers out and releases the hold.
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
        const [row] = await db
          .select({ held: s.held, deviceId: s.deviceId })
          .from(s)
          .where(eq(s.id, found.session.id))
          .limit(1);
        if (!row?.held) return ctx.json({ held: false, since: null });
        const [oldest] = await db
          .select({ createdAt: s.createdAt })
          .from(s)
          .where(
            and(
              eq(s.userId, found.user.id),
              eq(s.held, false),
              gt(s.expiresAt, new Date()),
              ne(s.id, found.session.id),
              or(isNull(s.userAgent), notLike(s.userAgent, STAFF_KEY_AGENT)),
            ),
          )
          .orderBy(desc(s.createdAt))
          .limit(1);
        return ctx.json({ held: true, since: oldest?.createdAt.toISOString() ?? null });
      }),
      replaceOtherSessions: createAuthEndpoint(
        "/other-sessions/replace",
        { method: "POST" },
        async (ctx) => {
          const found = await getSessionFromCtx(ctx);
          if (!found) throw new APIError("UNAUTHORIZED");
          const sessionId = found.session.id;
          const userId = found.user.id;
          const [row] = await db
            .select({ held: s.held, deviceId: s.deviceId })
            .from(s)
            .where(eq(s.id, sessionId))
            .limit(1);
          if (!row?.held) return ctx.json({ replaced: 0 });
          const others = await othersOf(db, userId, row.deviceId ?? "", sessionId);
          const now = new Date();
          const gone = await db.transaction(async (tx) => {
            // Every other session of the person goes, held ones and this browser's stale
            // ones included; staff API keys stay.
            const deleted = await tx
              .delete(s)
              .where(
                and(
                  eq(s.userId, userId),
                  ne(s.id, sessionId),
                  or(isNull(s.userAgent), notLike(s.userAgent, STAFF_KEY_AGENT)),
                ),
              )
              .returning({ id: s.id });
            await tx.update(s).set({ held: false, lastSeenAt: now }).where(eq(s.id, sessionId));
            await tx
              .update(schema.auth_sign_in_overlap)
              .set({ replacedAt: now })
              .where(eq(schema.auth_sign_in_overlap.sessionId, sessionId));
            return deleted.length;
          });
          opts.onOverlap?.({
            userId,
            sessionId,
            deviceId: row.deviceId,
            outcome: "replaced",
            ...summary(others),
          });
          return ctx.json({ replaced: gone });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
