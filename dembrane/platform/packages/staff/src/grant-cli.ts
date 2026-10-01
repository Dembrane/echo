#!/usr/bin/env bun
/**
 * Grants, revokes and lists staff (the Directus Administrator role) on the database in
 * DATABASE_URL. Needs the database login on purpose: no API key can make someone staff.
 *   bun run staff:access list
 *   bun run staff:access grant <email> --by <your-staff-email>
 *   bun run staff:access revoke <email> --by <your-staff-email>
 */
import { DrizzleStaffAudit } from "@dembrane/access";
import { createDb } from "@dembrane/db";
import { GrantError, staffGrants } from "./grant";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const args = process.argv.slice(2);
const flag = args.indexOf("--by");
const by = flag >= 0 ? args[flag + 1] : undefined;
const [cmd, email] = args.filter((_, i) => flag < 0 || (i !== flag && i !== flag + 1));
const database = createDb({ url, poolMax: 1 });
const grants = staffGrants(database.db, new DrizzleStaffAudit(database.db));
const out = (line: string) => process.stdout.write(`${line}\n`);
try {
  if (cmd === "list") {
    const r = await grants.list();
    for (const s of r.staff) out(`staff\t${s.email}\t${s.id}`);
    for (const s of r.directPolicyOnly) out(`policy-only\t${s.email}\t${s.id}`);
  } else if ((cmd === "grant" || cmd === "revoke") && email && by) {
    const r = await grants[cmd](email, by);
    out(`${cmd} ${email}: ${r.changed ? "done" : "no change"}`);
  } else {
    process.stderr.write(
      "usage: staff:access list | grant <email> --by <staff-email> | revoke <email> --by <staff-email>\n",
    );
    process.exitCode = 2;
  }
} catch (e) {
  if (!(e instanceof GrantError)) throw e;
  process.stderr.write(`${e.message}\n`);
  process.exitCode = 1;
} finally {
  await database.close();
}
