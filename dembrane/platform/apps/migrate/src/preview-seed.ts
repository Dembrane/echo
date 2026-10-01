import { administratorRole, ensureUser, seedAccountsDemoFromEnv } from "@dembrane/accounts";
import { assetPath } from "@dembrane/core";
import { createDb, PREVIEW_DATABASE, schema } from "@dembrane/db";
import { seedMillbrook } from "@dembrane/samples";
import { and, eq, isNull } from "drizzle-orm";

/**
 * What every PR preview holds after its migrations: a staff Administrator who signs in with
 * email and password, the Millbrook sample project (generated conversations, a report, a
 * chat) in the fictional org Acme Civic (sample) that admin owns, and the accounts demo for
 * the fictional customer Example Town Council (sample), whose two logins get the same
 * password. Every organisation, person and conversation in it is invented. It
 * runs only on a PR preview's own database (APP_ENV preview, DATABASE_NAME echo_pr_<n>), so
 * a mistaken switch on staging or prod refuses before touching anything.
 */

export const PREVIEW_ADMIN_EMAIL = "sameer+admin@dembrane.com";

/** The demos/ files the accounts demo reads, carried by the migrate image. */
export const PREVIEW_SEED_ASSETS = [
  "demos/example-en/fixture.json",
  "demos/example-en/research.md",
  "demos/sales-portal.json",
];

type Env = Readonly<Record<string, string | undefined>>;

export function previewSeedRefusal(env: Env): string | null {
  if (env.APP_ENV !== "preview") return `APP_ENV is ${env.APP_ENV ?? "unset"}, not preview`;
  if (!PREVIEW_DATABASE.test(env.DATABASE_NAME ?? ""))
    return "DATABASE_NAME is not a PR preview database (echo_pr_<number>)";
  if ((env.PREVIEW_ADMIN_PASSWORD ?? "").length < 12)
    return "PREVIEW_ADMIN_PASSWORD must be set, at least 12 characters";
  return null;
}

export async function seedPreview(url: string, env: Env, now = new Date()) {
  const refusal = previewSeedRefusal(env);
  if (refusal) throw new Error(`preview seed refused: ${refusal}`);
  const password = env.PREVIEW_ADMIN_PASSWORD as string;
  const database = createDb({ url, poolMax: 2 });
  try {
    const db = database.db;
    const role = await administratorRole(db);
    const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id" });
    const admin = await db.transaction((tx) =>
      ensureUser(tx, {
        email: PREVIEW_ADMIN_EMAIL,
        name: "Preview admin",
        passwordHash,
        nowIso: now.toISOString(),
        directusRoleId: role,
      }),
    );
    // Past the sign-up questionnaire, which the dashboard otherwise opens on every login.
    await db
      .update(schema.app_user)
      .set({ onboarding_answer_json: { version: "17-jun-26", data: [], skipped: true } })
      .where(
        and(
          eq(schema.app_user.id, admin.appUserId),
          isNull(schema.app_user.onboarding_answer_json),
        ),
      );
    const sample = await seedMillbrook(db, admin, now);
    const demo = await seedAccountsDemoFromEnv(db, {
      password,
      language: "en",
      demosDir: assetPath("demos"),
      env,
    });
    return {
      admin: PREVIEW_ADMIN_EMAIL,
      sample,
      accounts_demo: { org_id: demo.org_id, logins: [demo.customer_email, demo.staff_email] },
    };
  } finally {
    await database.close();
  }
}
