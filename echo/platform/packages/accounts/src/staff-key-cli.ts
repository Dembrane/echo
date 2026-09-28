#!/usr/bin/env bun
/**
 * Mints or revokes a staff API key for sam.
 *   DATABASE_URL=... bun run accounts:staff-key mint <staff-email> <label> [days]
 *   DATABASE_URL=... bun run accounts:staff-key revoke <label>
 * The key is printed once, to stdout; store it in Secret Manager straight away.
 */
import { createDb } from "@echo/db";
import { mintStaffKey, revokeStaffKeys } from "./staff-key";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const [cmd, a, b, c] = process.argv.slice(2);
const database = createDb({ url, poolMax: 1 });
try {
  if (cmd === "mint" && a && b) {
    const r = await mintStaffKey(database.db, a, b, c ? { days: Number(c) } : {});
    process.stdout.write(`${r.key}\n`);
    process.stderr.write(`key for ${a} (${b}) valid until ${r.expiresAt.toISOString()}\n`);
  } else if (cmd === "revoke" && a) {
    process.stderr.write(`revoked ${await revokeStaffKeys(database.db, a)} key(s)\n`);
  } else {
    process.stderr.write("usage: staff-key mint <email> <label> [days] | revoke <label>\n");
    process.exitCode = 2;
  }
} finally {
  await database.close();
}
