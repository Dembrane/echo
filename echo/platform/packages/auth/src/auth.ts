import type { Db } from "@echo/db";
import { schema } from "@echo/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, emailOTP, twoFactor } from "better-auth/plugins";
import { eq } from "drizzle-orm";

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
  /** Directus role every new signup gets while Directus tables still back foreign keys. */
  readonly defaultDirectusRoleId: string | null;
}

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
      minPasswordLength: 8,
      password: {
        hash: (password) => Bun.password.hash(password, { algorithm: "argon2id" }),
        verify: ({ hash, password }) => Bun.password.verify(password, hash),
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
    },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: 600,
        sendVerificationOTP: async ({ email, otp, type }) => opts.sendCode(email, otp, type),
      }),
      twoFactor({ issuer: "dembrane" }),
      bearer(),
    ],
    databaseHooks: {
      user: {
        create: {
          // Until the contract phase, every user also has the rows the rest of the schema
          // points at: directus_users (foreign keys) and app_user (memberships).
          after: async (user) => {
            await opts.db.transaction(async (tx) => {
              const [first, ...rest] = (user.name ?? "").split(" ");
              await tx
                .insert(schema.directus_users)
                .values({
                  id: user.id,
                  email: user.email,
                  first_name: first || null,
                  last_name: rest.join(" ") || null,
                  status: "active",
                  role: opts.defaultDirectusRoleId,
                  provider: "default",
                })
                .onConflictDoNothing();
              const existing = await tx
                .select({ id: schema.app_user.id })
                .from(schema.app_user)
                .where(eq(schema.app_user.directus_user_id, user.id))
                .limit(1);
              if (existing.length === 0) {
                await tx.insert(schema.app_user).values({
                  id: Bun.randomUUIDv7(),
                  directus_user_id: user.id,
                  email: user.email,
                  display_name: user.name || null,
                });
              }
            });
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
