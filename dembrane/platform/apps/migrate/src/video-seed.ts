// Seeds a local database for the release videos (dembrane/frontend/videos): one ordinary
// user (not staff) who owns the Millbrook sample and the best practices sample in the same
// workspace, past the sign-up questionnaire. A rerun
// soft-deletes what the previous recording made (its new project, the portal's
// conversations), so every recording starts from the same screens. Local only.
// Run from dembrane/platform: bun --env-file=.env.local apps/migrate/src/video-seed.ts
import { ensureUser } from "@dembrane/accounts";
import { createDb, schema } from "@dembrane/db";
import {
  BEST_PRACTICES_IDS,
  MILLBROOK_CONVERSATION_IDS,
  MILLBROOK_IDS,
  seedBestPractices,
  seedMillbrook,
} from "@dembrane/samples";
import { and, eq, isNull, notInArray } from "drizzle-orm";

export const VIDEO_USER = {
  email: process.env.VIDEO_EMAIL ?? "alex@example.org",
  name: "Alex Morgan",
  password: process.env.VIDEO_PASSWORD ?? "video-recording-only",
};

if (process.env.APP_ENV !== "local")
  throw new Error(`video seed is local only, APP_ENV is ${process.env.APP_ENV}`);

const now = new Date();
const database = createDb({ url: process.env.DATABASE_URL as string, poolMax: 2 });
try {
  const db = database.db;
  const passwordHash = await Bun.password.hash(VIDEO_USER.password, { algorithm: "argon2id" });
  const user = await db.transaction((tx) =>
    ensureUser(tx, {
      email: VIDEO_USER.email,
      name: VIDEO_USER.name,
      passwordHash,
      nowIso: now.toISOString(),
    }),
  );
  await db
    .update(schema.app_user)
    .set({ onboarding_answer_json: { version: "17-jun-26", data: [], skipped: true } })
    .where(eq(schema.app_user.id, user.appUserId));
  const sample = await seedMillbrook(db, user, now);
  // The sample is never recreated once deleted, so bring back a copy a recording deleted.
  const bestPracticesId = BEST_PRACTICES_IDS.project(MILLBROOK_IDS.workspace);
  await db
    .update(schema.project)
    .set({ deleted_at: null })
    .where(eq(schema.project.id, bestPracticesId));
  const bestPractices = await seedBestPractices(db, user, MILLBROOK_IDS.workspace, now);
  const stamp = now.toISOString();
  await db
    .update(schema.project)
    .set({ deleted_at: stamp })
    .where(
      and(
        eq(schema.project.workspace_id, MILLBROOK_IDS.workspace),
        notInArray(schema.project.id, [MILLBROOK_IDS.project, bestPracticesId]),
        isNull(schema.project.deleted_at),
      ),
    );
  await db
    .update(schema.conversation)
    .set({ deleted_at: stamp })
    .where(
      and(
        eq(schema.conversation.project_id, MILLBROOK_IDS.project),
        notInArray(schema.conversation.id, [...MILLBROOK_CONVERSATION_IDS]),
        isNull(schema.conversation.deleted_at),
      ),
    );
  process.stdout.write(`${JSON.stringify({ login: VIDEO_USER.email, sample, bestPractices })}\n`);
} finally {
  await database.close();
}
