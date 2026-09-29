import { administratorRole, ensureUser, seedAccountsDemoFromEnv } from "@dembrane/accounts";
import { assetPath } from "@dembrane/core";
import { createDb, PREVIEW_DATABASE } from "@dembrane/db";
import { seedMillbrook } from "@dembrane/samples";

/**
 * What every PR preview holds after its migrations: a staff Administrator who signs in with
 * email and password, the Millbrook sample project (conversations, a report, a chat) in an
 * org that admin owns, and the accounts demo, whose two logins get the same password. It
 * runs only on a PR preview's own database (APP_ENV preview, DATABASE_NAME echo_pr_<n>), so
 * a mistaken switch on next or prod refuses before touching anything.
 */

export const PREVIEW_ADMIN_EMAIL = "sameer+admin@dembrane.com";

/** The dembrane/demos files the accounts demo reads, carried by the migrate image. */
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
