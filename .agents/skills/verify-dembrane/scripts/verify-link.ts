#!/usr/bin/env bun
// Prints the email-verification link for an address, as the API's email would carry it.
// Locally the email stays in the API's memory, so this mints the same token: Better Auth's
// verification token is an HS256 JWT of { email } signed with AUTH_SECRET from platform/.env.local.
// Usage: bun verify-link.ts <email> <dashboard-url>
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const [email, dashboardUrl] = process.argv.slice(2);
if (!email || !dashboardUrl) throw new Error("usage: bun verify-link.ts <email> <dashboard-url>");
const envFile = path.resolve(import.meta.dir, "../../../../dembrane/platform/.env.local");
const secret = readFileSync(envFile, "utf8").match(/^AUTH_SECRET=(.*)$/m)?.[1]?.trim();
if (!secret) throw new Error(`no AUTH_SECRET in ${envFile}`);
const b64 = (v: string | Buffer) => Buffer.from(v).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const head = `${b64(JSON.stringify({ alg: "HS256" }))}.${b64(JSON.stringify({ email: email.toLowerCase(), exp: now + 3600, iat: now }))}`;
const sig = createHmac("sha256", secret).update(head).digest("base64url");
console.log(`${dashboardUrl}/verify-email?token=${head}.${sig}`);
