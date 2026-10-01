#!/usr/bin/env bun
/**
 * bun run seed:accounts-demo: rebuilds the accounts demo on the
 * database in DATABASE_URL. The two demo logins get the password in DEMO_PASSWORD, which is
 * read from the environment only. DEMO_LANGUAGE (en, the default, or nl) sets the language
 * of the offer, tasks, question and corpus. APP_ENV picks the environment's URLs; prod is
 * refused, and so is any environment without the file bucket.
 */
import { createDb } from "@dembrane/db";
import { seedAccountsDemoFromEnv } from "./seed-env";

const url = process.env.DATABASE_URL;
const password = process.env.DEMO_PASSWORD;
const language = (process.env.DEMO_LANGUAGE ?? "en").toLowerCase();
if (language !== "en" && language !== "nl") throw new Error("DEMO_LANGUAGE is en or nl");
if (!url) throw new Error("DATABASE_URL is required");
if (!password) throw new Error("DEMO_PASSWORD is required");
const database = createDb({ url, poolMax: 2 });
try {
  const summary = await seedAccountsDemoFromEnv(database.db, {
    password,
    language,
    demosDir: new URL("../../../demos", import.meta.url).pathname,
    env: process.env,
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} finally {
  await database.close();
}
