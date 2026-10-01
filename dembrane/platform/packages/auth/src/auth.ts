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
    database: drizzleAdapter(opts.db, {
      provider: "pg",
      schema: {
        user: schema.auth_user,
        session: schema.auth_session,
        account: schema.auth_account,
        verification: schema.auth_verification,
        twoFactor: schema.auth_two_factor,
      },
    }),
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

/** Directus's role for public signups (Basic User on prod). */
async function publicRegistrationRole(db: Db): Promise<string | null> {
  const [row] = await db
    .select({ role: schema.directus_settings.public_registration_role })
    .from(schema.directus_settings)
    .limit(1);
  return row?.role ?? null;
}

export type Auth = ReturnType<typeof createAuth>;
