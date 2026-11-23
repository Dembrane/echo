import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import * as K from "../src/contract";
import { accountsRoutes } from "../src/routes";
import { admin, call, dropDatabase, type World, world } from "./helpers";

// The staff list's per-organisation counts.
const run = admin ? describe : describe.skip;
const DB = `accounts_staff_counts_${process.pid}`;

run("the staff list counts what is open per organisation", () => {
  setDefaultTimeout(60_000);
  let w: World;
  beforeAll(async () => {
    w = await world(DB, accountsRoutes);
  });
  afterAll(async () => {
    await w?.close();
    await dropDatabase(DB);
  });

  const row = async (orgId: string) =>
    K.AccountList.parse(
      (await call(w, "GET", "/api/v2/admin/accounts?limit=200", "staff")).data,
    ).accounts.find((a) => a.id === orgId);

  test("an open question and an open task show on the organisation's row", async () => {
    const before = await row(w.orgId);
    const asked = await call(w, "POST", `/api/v2/orgs/${w.orgId}/account/tickets`, "admin", {
      subject: "Where is my invoice?",
      body: "I cannot find it.",
    });
    expect(asked.status).toBe(201);
    const task = await call(w, "POST", `/api/v2/admin/accounts/${w.orgId}/tasks`, "staff", {
      title: "Upload your logo",
    });
    expect(task.status).toBe(201);

    const after = await row(w.orgId);
    expect(after?.open_tickets).toBe((before?.open_tickets ?? 0) + 1);
    expect(after?.open_tasks).toBe((before?.open_tasks ?? 0) + 1);
  });
});
