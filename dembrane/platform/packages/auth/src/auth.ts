import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { bearer, emailOTP, twoFactor } from "better-auth/plugins";
import { and, eq } from "drizzle-orm";

export interface AuthOptions {
  readonly db: Db;
  readonly secret: string;
  /** Public URL of the API; Better Auth serves under <baseURL>/api/auth. */
  readonly baseURL: string;
  readonly trustedOrigins: readonly string[];
  readonly cookieDomain?: string | undefined;
  readonly secureCookies: boolean;
  readonly google?: { readonly clientId: string; readonly clientSecret: string } | undefined;
  /** Delivers the one-time sign-in code. */
  readonly sendCode: (email: string, code: string, purpose: string) => Promise<void>;
  /**
   * Whether a sign-in code may go to this address: people who have an account or a pending
   * invitation (org, workspace, or to sign one document). Anyone else gets no email, and
   * the response is the same, so the endpoint does not reveal who has an account. Unset
   * sends to every address, which is how sign-up by code worked before.
   */
  readonly codeSignInAllowed?: (email: string) => Promise<boolean>;
  /**
   * Delivers the email-verification link of a new signup. `url` is Better Auth's own
   * verify URL; `token` lets the caller build the dashboard link the email should carry.
   */
  readonly sendVerification?: (email: string, url: string, token: string) => Promise<void>;
  /**
   * Delivers the password-reset link. `url` is Better Auth's own reset URL, which checks
   * the token and redirects to the dashboard page the request named with `?token=`.
   */
  readonly sendResetPassword?: (email: string, url: string, token: string) => Promise<void>;
  /**
   * Directus role every new signup gets while Directus tables still back foreign keys.
   * Null reads Directus's public registration role, so each environment keeps its own.
   */
  readonly defaultDirectusRoleId: string | null;
}

/**
 * The API puts the caller's address, as it resolved it, in this header before handing a
 * request to sign-in. Whatever the caller sent under the same name is overwritten.
 */
export const AUTH_CLIENT_IP_HEADER = "x-client-ip";

/**
 * Identity: who someone is, never what they may do (that is the access package).
 * Passwords keep the argon2id hashes Directus wrote, so nobody resets at cutover.
 */
export function createAuth(opts: AuthOptions) {
  return betterAuth({
    appName: "dembrane",
    secret: opts.secret,
    baseURL: opts.baseURL,
    basePath: "/api/auth",
    trustedOrigins: [...opts.trustedOrigins],
    database: uuidVerificationIds(
      drizzleAdapter(opts.db, {
        provider: "pg",
        schema: {
          user: schema.auth_user,
          session: schema.auth_session,
          account: schema.auth_account,
          verification: schema.auth_verification,
          twoFactor: schema.auth_two_factor,
        },
      }),
    ),
    emailAndPassword: {
      enabled: true,
      // Unverified signups cannot sign in, as with Directus's verified public registration.
      requireEmailVerification: true,
      minPasswordLength: 8,
      maxPasswordLength: 256,
      password: {
        hash: (password) => Bun.password.hash(password, { algorithm: "argon2id" }),
        verify: ({ hash, password }) => Bun.password.verify(password, hash),
      },
      sendResetPassword: async ({ user, url, token }) => {
        await opts.sendResetPassword?.(user.email, url, token);
      },
      revokeSessionsOnPasswordReset: true,
      // The link came to the inbox, so it verifies the email as a code sign-in does, and
      // Directus keeps the same hash, as changePassword does.
      onPasswordReset: async ({ user }) => {
        const [acc] = await opts.db
          .select({ hash: schema.auth_account.password })
          .from(schema.auth_account)
          .where(
            and(
              eq(schema.auth_account.userId, user.id),
              eq(schema.auth_account.providerId, "credential"),
            ),
          )
          .limit(1);
        await opts.db.transaction(async (tx) => {
          if (acc?.hash)
            await tx
              .update(schema.directus_users)
              .set({ password: acc.hash })
              .where(eq(schema.directus_users.id, user.id));
          if (user.emailVerified) return;
          await tx
            .update(schema.auth_user)
            .set({ emailVerified: true, updatedAt: new Date() })
            .where(eq(schema.auth_user.id, user.id));
          await tx
            .update(schema.directus_users)
            .set({ status: "active" })
            .where(
              and(
                eq(schema.directus_users.id, user.id),
                eq(schema.directus_users.status, "unverified"),
              ),
            );
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url, token }) => {
        await opts.sendVerification?.(user.email, url, token);
      },
      // The Directus row of a verified signup becomes active, as Directus's verify did.
      afterEmailVerification: async (user) => {
        await opts.db
          .update(schema.directus_users)
          .set({ status: "active" })
          .where(
            and(
              eq(schema.directus_users.id, user.id),
              eq(schema.directus_users.status, "unverified"),
            ),
          );
      },
    },
    ...(opts.google && {
      socialProviders: {
        google: { clientId: opts.google.clientId, clientSecret: opts.google.clientSecret },
      },
    }),
    session: {
      expiresIn: 7 * 24 * 3600,
      updateAge: 24 * 3600,
    },
    advanced: {
      cookiePrefix: "dembrane",
      useSecureCookies: opts.secureCookies,
      ...(opts.cookieDomain && {
        crossSubDomainCookies: { enabled: true, domain: opts.cookieDomain },
      }),
      database: { generateId: () => Bun.randomUUIDv7() },
      ipAddress: { ipAddressHeaders: [AUTH_CLIENT_IP_HEADER] },
    },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: 600,
        sendVerificationOTP: async ({ email, otp, type }) => {
          if (
            type === "sign-in" &&
            opts.codeSignInAllowed &&
            !(await opts.codeSignInAllowed(email))
          )
            return;
          await opts.sendCode(email, otp, type);
        },
      }),
      twoFactor({ issuer: "dembrane" }),
      bearer(),
    ],
    databaseHooks: {
      user: {
        create: {
          // Until the contract phase, every user also has the directus_users row the rest
          // of the schema points at. The app_user row is not made here: creating it is what
          // completes onboarding (POST /api/v2/onboarding/complete), which /me reports.
          after: async (user) => {
            const role = opts.defaultDirectusRoleId ?? (await publicRegistrationRole(opts.db));
            const [first, ...rest] = (user.name ?? "").split(" ");
            await opts.db
              .insert(schema.directus_users)
              .values({
                id: user.id,
                email: user.email,
                first_name: first || null,
                last_name: rest.join(" ") || null,
                status: user.emailVerified ? "active" : "unverified",
                role,
                provider: "default",
              })
              .onConflictDoNothing();
          },
        },
      },
      session: {
        create: {
          // A suspended or archived user (account deletion requested, staff action) gets no
          // session. Unverified is left to Better Auth, which refuses password sign-in until
          // the email is verified and verifies it on a code sign-in.
          before: async (session) => {
            const [row] = await opts.db
              .select({ status: schema.directus_users.status })
              .from(schema.directus_users)
              .where(eq(schema.directus_users.id, session.userId))
              .limit(1);
            if (row?.status === "suspended" || row?.status === "archived")
              throw new APIError("FORBIDDEN", { message: "This account is not active" });
          },
        },
      },
    },
  });
}

type AdapterInstance = ReturnType<typeof drizzleAdapter>;
type Adapter = ReturnType<AdapterInstance>;
type Where = { field: string; value: unknown };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Better Auth takes a lock by inserting a verification row whose id is a base64url SHA-256
 * of the lock name, bypassing generateId (reserveVerificationValue, run when a code sign-in
 * promotes an unverified user). auth_verification.id is a uuid column, so without this every
 * code sign-in of an unverified user, such as a contact the accounts package created, fails
 * with a 500. Such an id becomes a UUID derived from it, so the insert succeeds and a second
 * insert under the same lock name still collides on the primary key, which is what makes it
 * a lock. Ids that are already UUIDs (everything generateId makes) pass through unchanged.
 */
function uuidVerificationIds(inner: AdapterInstance): AdapterInstance {
  return (options) => wrapAdapter(inner(options));
}

function wrapAdapter(adapter: Adapter): Adapter {
  const wrapped = { ...adapter } as Record<string, unknown>;
  for (const [name, fn] of Object.entries(adapter)) {
    if (typeof fn !== "function") continue;
    wrapped[name] =
      name === "transaction"
        ? (cb: (trx: Adapter) => Promise<unknown>) =>
            adapter.transaction((trx) => cb(wrapAdapter(trx as Adapter)))
        : (arg: unknown, ...rest: unknown[]) =>
            (fn as (...a: unknown[]) => unknown).call(adapter, verificationArg(arg), ...rest);
  }
  return wrapped as Adapter;
}

function verificationArg(arg: unknown): unknown {
  if (!arg || typeof arg !== "object") return arg;
  const a = arg as { model?: unknown; data?: Record<string, unknown>; where?: Where[] };
  if (a.model !== "verification") return arg;
  return {
    ...a,
    ...(a.data && typeof a.data.id === "string" && { data: { ...a.data, id: asUuid(a.data.id) } }),
    ...(a.where && {
      where: a.where.map((w) =>
        w.field !== "id"
          ? w
          : {
              ...w,
              value: Array.isArray(w.value)
                ? w.value.map((v) => (typeof v === "string" ? asUuid(v) : v))
                : typeof w.value === "string"
                  ? asUuid(w.value)
                  : w.value,
            },
      ),
    }),
  };
}

/** A UUID (version 8, RFC 9562) derived from any other id, the same input giving the same UUID. */
function asUuid(id: string): string {
  if (UUID.test(id)) return id;
  const b = new Bun.CryptoHasher("sha256").update(id).digest();
  b[6] = ((b[6] as number) & 0x0f) | 0x80;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const h = b.subarray(0, 16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Directus's role for public signups (Basic User on prod). */
async function publicRegistrationRole(db: Db): Promise<string | null> {
  const [row] = await db
    .select({ role: schema.directus_settings.public_registration_role })
    .from(schema.directus_settings)
    .limit(1);
  return row?.role ?? null;
}

export type Auth = ReturnType<typeof createAuth>;
