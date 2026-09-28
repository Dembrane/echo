#!/usr/bin/env bun
/**
 * bun run seed:accounts-demo: rebuilds the accounts demo on the
 * database in DATABASE_URL. The two demo logins get the password in DEMO_PASSWORD, which is
 * read from the environment only. DEMO_LANGUAGE (en, the default, or nl) sets the language
 * of the offer, tasks, question and corpus. APP_ENV picks the environment's URLs; prod is
 * refused, and so is any environment without the file bucket.
 */
import { Access, DrizzleAccessStore } from "@dembrane/access";
import { environments } from "@dembrane/config";
import { createDb } from "@dembrane/db";
import { createLogger } from "@dembrane/observability";
import { FilesystemStorage, requireBucket, S3Storage } from "@dembrane/storage";
import { httpFetchText } from "./deps";
import { seedAccountsDemo } from "./seed";

const env = process.env.APP_ENV ?? "local";
if (env === "prod") throw new Error("The accounts demo is never seeded on production.");
const url = process.env.DATABASE_URL;
const password = process.env.DEMO_PASSWORD;
const language = (process.env.DEMO_LANGUAGE ?? "en").toLowerCase();
if (language !== "en" && language !== "nl") throw new Error("DEMO_LANGUAGE is en or nl");
if (!url) throw new Error("DATABASE_URL is required");
if (!password) throw new Error("DEMO_PASSWORD is required");
const http = (environments as Record<string, { http?: Record<string, string> }>)[env]?.http ?? {};
const dashboardUrl = process.env.DASHBOARD_URL ?? http.dashboardUrl ?? "http://localhost:5173";
const portalUrl = process.env.PORTAL_URL ?? http.portalUrl ?? "http://localhost:5174";
const apiUrl = process.env.API_PUBLIC_URL ?? http.publicUrl ?? "http://localhost:8080";
const files = process.env.FILES_S3_BUCKET
  ? new S3Storage({
      endpoint: process.env.FILES_S3_ENDPOINT ?? "",
      bucket: process.env.FILES_S3_BUCKET,
      region: process.env.FILES_S3_REGION ?? "auto",
      accessKeyId: process.env.FILES_S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.FILES_S3_SECRET_ACCESS_KEY ?? "",
    })
  : new FilesystemStorage(process.env.FILES_LOCAL_ROOT ?? ".data/files", apiUrl);
// A demo on preview or next writes its PDFs and logo to the bucket the API serves from.
requireBucket(env, files, "The demo's PDFs and logo", "FILES_S3_BUCKET");
const logger = createLogger({ service: "seed-accounts-demo", release: "dev", env, level: "info" });
const database = createDb({ url, poolMax: 2 });
try {
  const summary = await seedAccountsDemo({
    db: database.db,
    files,
    access: new Access(new DrizzleAccessStore(database.db)),
    logger,
    now: new Date(),
    password,
    env,
    dashboardUrl,
    portalUrl,
    apiUrl,
    company: {
      name: "dembrane B.V.",
      address: process.env.ACCOUNTS_COMPANY_ADDRESS ?? "Sint Janssingel 88, ‘s-Hertogenbosch, NL",
      vat: process.env.ACCOUNTS_COMPANY_VAT ?? "NL864967433B01",
      kvk: process.env.ACCOUNTS_COMPANY_KVK ?? "89391438",
      iban: process.env.ACCOUNTS_BANK_IBAN ?? "NL49 RABO 0318910535",
      bic: process.env.ACCOUNTS_BANK_BIC ?? "RABONL2U",
      accountName: process.env.ACCOUNTS_BANK_ACCOUNT_NAME ?? "Dembrane B.V.",
    },
    demosDir: new URL("../../../../demos", import.meta.url).pathname,
    language,
    fetchText: httpFetchText,
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} finally {
  await database.close();
}
