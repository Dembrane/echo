#!/usr/bin/env bash
# Gives a signed-in account a project with a finished report, for recipes that start on one.
# Generating a report needs an LLM, which the local config leaves unset, so this runs the
# product's own Millbrook sample seeder (the one PR previews use) for the account instead.
#   seed-report.sh <workspace-id>   the account's workspace, as seed-user.sh --org prints it
# Prints the sample's workspace_id, project_id and report_id. It lands in its own organisation,
# "Acme Civic (sample)".
set -euo pipefail
. "$(dirname "$0")/lib.sh"
pick_run
WORKSPACE=${1:?usage: seed-report.sh <workspace-id>}
cd "$PLATFORM"
DATABASE_URL=$DB_URL bun -e '
const { createDb } = await import("./packages/db/src/index.ts");
const { seedMillbrook, sampleOwner } = await import("./packages/samples/src/index.ts");
const database = createDb({ url: process.env.DATABASE_URL, poolMax: 2 });
try {
  const owner = await sampleOwner(database.db, process.argv[1]);
  if (!owner) throw new Error(`no owner for workspace ${process.argv[1]}`);
  console.log(JSON.stringify(await seedMillbrook(database.db, owner, new Date())));
} finally {
  await database.close();
}' "$WORKSPACE"
