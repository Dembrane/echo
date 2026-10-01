import { Access, DrizzleAccessStore } from "@dembrane/access";
import { environments } from "@dembrane/config";
import type { Db } from "@dembrane/db";
import { createLogger } from "@dembrane/observability";
import { FilesystemStorage, requireBucket, S3Storage } from "@dembrane/storage";
import { httpFetchText } from "./deps";
import { type SeedSummary, seedAccountsDemo } from "./seed";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The accounts demo with its URLs, bucket and company details read from the environment:
 * APP_ENV picks the environment's URLs unless DASHBOARD_URL, PORTAL_URL or API_PUBLIC_URL
 * name them, and FILES_S3_* the bucket (and key prefix) its PDFs and logo go to. Shared by
 * `bun run seed:accounts-demo` and the PR preview seed in the migrate job.
 */
export async function seedAccountsDemoFromEnv(
  db: Db,
  o: { password: string; language: "en" | "nl"; demosDir: string; env: Env },
): Promise<SeedSummary> {
  const e = o.env;
  const env = e.APP_ENV ?? "local";
  if (env === "prod") throw new Error("The accounts demo is never seeded on production.");
  const http = (environments as Record<string, { http?: Record<string, string> }>)[env]?.http ?? {};
  const apiUrl = e.API_PUBLIC_URL ?? http.publicUrl ?? "http://localhost:8080";
  const files = e.FILES_S3_BUCKET
    ? new S3Storage({
        endpoint: e.FILES_S3_ENDPOINT ?? "",
        bucket: e.FILES_S3_BUCKET,
        region: e.FILES_S3_REGION ?? "auto",
        accessKeyId: e.FILES_S3_ACCESS_KEY_ID ?? "",
        secretAccessKey: e.FILES_S3_SECRET_ACCESS_KEY ?? "",
        prefix: e.FILES_S3_PREFIX,
      })
    : new FilesystemStorage(e.FILES_LOCAL_ROOT ?? ".data/files", apiUrl);
  // A demo on preview or next writes its PDFs and logo to the bucket the API serves from.
  requireBucket(env, files, "The demo's PDFs and logo", "FILES_S3_BUCKET");
  return seedAccountsDemo({
    db,
    files,
    access: new Access(new DrizzleAccessStore(db)),
    logger: createLogger({ service: "seed-accounts-demo", release: "dev", env, level: "info" }),
    now: new Date(),
    password: o.password,
    env,
    dashboardUrl: e.DASHBOARD_URL ?? http.dashboardUrl ?? "http://localhost:5173",
    portalUrl: e.PORTAL_URL ?? http.portalUrl ?? "http://localhost:5174",
    apiUrl,
    company: {
      name: "dembrane B.V.",
      address: e.ACCOUNTS_COMPANY_ADDRESS ?? "Sint Janssingel 88, ‘s-Hertogenbosch, NL",
      vat: e.ACCOUNTS_COMPANY_VAT ?? "NL864967433B01",
      kvk: e.ACCOUNTS_COMPANY_KVK ?? "89391438",
      iban: e.ACCOUNTS_BANK_IBAN ?? "NL49 RABO 0318910535",
      bic: e.ACCOUNTS_BANK_BIC ?? "RABONL2U",
      accountName: e.ACCOUNTS_BANK_ACCOUNT_NAME ?? "Dembrane B.V.",
    },
    demosDir: o.demosDir,
    language: o.language,
    fetchText: httpFetchText,
  });
}
