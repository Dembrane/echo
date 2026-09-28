import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { newId } from "@echo/core";
import { schema } from "@echo/db";
import { sql } from "drizzle-orm";
import * as K from "../src/contract";
import { accountsRoutes } from "../src/routes";
import { store } from "../src/storage";
import { admin, call, dropDatabase, type World, world } from "./helpers";

// Accounts without a demo (any organisation, the staff list over all of them, offer
// drafts) and the signed-in person's task summary.
const run = admin ? describe : describe.skip;
const DB = `accounts_two_${process.pid}`;

run("accounts for any organisation, and the tasks summary", () => {
  setDefaultTimeout(60_000);
  let w: World;
  let selfServe = "";
  const offer = (over: Record<string, unknown> = {}) => ({
    template: "subscription",
    language: "en",
    offer_name: "Self Serve Co",
    items: [{ description: "Licence", quantity: 12, unit_price_cents: 8600, vat_rate_bps: 2100 }],
    ...over,
  });

  beforeAll(async () => {
    w = await world(DB, accountsRoutes);
    // A free-tier signup: an organisation with a member, no stage, nothing in it.
    selfServe = newId();
    await w.db.insert(schema.org).values({ id: selfServe, name: "Self Serve Co" });
    await w.db.insert(schema.org_membership).values({
      id: newId(),
      org_id: selfServe,
      user_id: w.people.admin.appUserId as string,
      role: "owner",
    });
  });
  afterAll(async () => {
    await w?.close();
    await dropDatabase(DB);
  });

  test("the staff list covers every organisation, filtered by stage and searched by name or member email", async () => {
    const list = async (qs: string) =>
      K.AccountList.parse((await call(w, "GET", `/api/v2/admin/accounts${qs}`, "staff")).data)
        .accounts.map((a) => a.name)
        .sort();
    expect(await list("")).toEqual(["Elders BV", "Gemeente Testdorp", "Self Serve Co"]);
    expect(await list("?stage=none")).toEqual(["Self Serve Co"]);
    expect(await list("?stage=prospect")).toEqual(["Elders BV", "Gemeente Testdorp"]);
    expect(await list("?q=testdorp")).toEqual(["Gemeente Testdorp"]);
    // By member email: the outsider is only in Elders BV; the admin in two organisations.
    expect(await list("?q=outsider%40example")).toEqual(["Elders BV"]);
    expect(await list("?q=admin%40example.test")).toEqual(["Gemeente Testdorp", "Self Serve Co"]);
    // LIKE wildcards are matched literally.
    expect(await list("?q=%25")).toEqual([]);
    expect((await call(w, "GET", "/api/v2/admin/accounts?stage=gone", "staff")).status).toBe(422);
    expect((await call(w, "GET", "/api/v2/admin/accounts?q=x", "admin")).status).toBe(403);
  });

  test("a self-serve organisation has no account content, so the summary leaves it out", async () => {
    const summary = K.TasksSummary.parse(
      (await call(w, "GET", "/api/v2/account/tasks-summary", "admin")).data,
    );
    expect(summary.map((s) => s.name)).toEqual(["Gemeente Testdorp"]);
    expect((await call(w, "GET", "/api/v2/account/tasks-summary", null)).status).toBe(401);
    // A plain member runs no account; the outsider's own organisation has a stage.
    expect(
      K.TasksSummary.parse((await call(w, "GET", "/api/v2/account/tasks-summary", "member")).data),
    ).toEqual([]);
    expect(
      K.TasksSummary.parse(
        (await call(w, "GET", "/api/v2/account/tasks-summary", "outsider")).data,
      ).map((s) => s.name),
    ).toEqual(["Elders BV"]);
  });

  test("enabling the account side of any organisation: staff only, stage, billing account and task", async () => {
    const path = `/api/v2/admin/accounts/${selfServe}/enable`;
    expect((await call(w, "POST", path, "admin", {})).status).toBe(403);
    expect((await call(w, "POST", path, "staff", { stage: "gone" })).status).toBe(422);
    expect(
      (await call(w, "POST", `/api/v2/admin/accounts/${newId()}/enable`, "staff", {})).status,
    ).toBe(404);
    const card = K.AccountCard.parse(
      (await call(w, "POST", path, "staff", { language: "en" })).data,
    );
    expect(card.organisation.account_stage).toBe("customer");
    expect(card.tasks.map((t) => [t.kind, t.status, t.title])).toEqual([
      ["billing_details", "locked", "Billing details"],
    ]);
    expect(await store.billing(w.db, selfServe)).not.toBeNull();
    // Twice is the same.
    K.AccountCard.parse((await call(w, "POST", path, "staff", {})).data);
    expect((await store.tasks(w.db, selfServe)).length).toBe(1);
  });

  test("an offer draft: no signing task yet, the customer does not see it, sending re-pins and opens the task", async () => {
    const r = await call(
      w,
      "POST",
      `/api/v2/admin/accounts/${selfServe}/offers`,
      "staff",
      offer({ send: false }),
    );
    expect(r.status).toBe(201);
    const pushed = K.PushOfferResponse.parse(r.data);
    expect(pushed.document.status).toBe("draft");
    expect(pushed.task).toBeNull();
    const page = K.AccountPage.parse(
      (await call(w, "GET", `/api/v2/orgs/${selfServe}/account`, "admin")).data,
    );
    expect(page.documents).toEqual([]);
    // The billing task waits for no offer yet: nothing is waiting for a signature.
    expect(page.tasks[0]?.locked_until_document_id).toBeNull();

    // A newer SLA is published while the offer is a draft; sending pins it.
    const sla = "https://www.dembrane.com/legal/sla";
    w.web.pages.set(
      sla,
      (w.web.pages.get(sla) as string)
        .replace("103 or later", "111 or later")
        .replace(
          'aria-label="Version" data-astro-cid-utsu5ych>1.1<',
          'aria-label="Version" data-astro-cid-utsu5ych>1.3<',
        ),
    );
    w.clock.now = new Date(w.clock.now.getTime() + 2 * 3600_000);
    const sent = K.DocumentDetail.parse(
      (
        await call(
          w,
          "POST",
          `/api/v2/admin/accounts/${selfServe}/documents/${pushed.document.id}/send`,
          "staff",
          {},
        )
      ).data,
    );
    expect(sent.status).toBe("sent");
    expect(sent.legal.find((l) => l.kind === "sla")?.version).toBe("1.3");
    expect(sent.sha256).not.toBe(pushed.document.sha256);
    const after = K.AccountPage.parse(
      (await call(w, "GET", `/api/v2/orgs/${selfServe}/account`, "admin")).data,
    );
    const sign = after.tasks.find((t) => t.kind === "sign");
    expect(sign?.status).toBe("open");
    // The locked billing task now names the offer it opens after.
    const billing = after.tasks.find((t) => t.kind === "billing_details");
    expect(billing?.locked_until_document_id).toBe(pushed.document.id);
    expect(billing?.locked_until_title).toBe("Self Serve Co x dembrane");
    const card = K.AccountCard.parse(
      (await call(w, "GET", `/api/v2/admin/accounts/${selfServe}`, "staff")).data,
    );
    expect(card.tasks.find((t) => t.kind === "billing_details")?.locked_until_title).toBe(
      "Self Serve Co x dembrane",
    );
  });

  test("the summary: done and total per organisation (locked counted, withdrawn not), the next open task", async () => {
    const orgTask = await call(w, "POST", `/api/v2/admin/accounts/${selfServe}/tasks`, "staff", {
      title: "Send us your logo",
    });
    const logo = K.Task.parse(orgTask.data);
    const withdrawn = K.Task.parse(
      (
        await call(w, "POST", `/api/v2/admin/accounts/${selfServe}/tasks`, "staff", {
          title: "Old",
        })
      ).data,
    );
    await call(
      w,
      "POST",
      `/api/v2/admin/accounts/${selfServe}/tasks/${withdrawn.id}/review`,
      "staff",
      { decision: "withdraw" },
    );
    await call(w, "POST", `/api/v2/orgs/${selfServe}/account/tasks/${logo.id}/submit`, "admin", {
      response_text: "attached",
    });
    await call(w, "POST", `/api/v2/admin/accounts/${selfServe}/tasks/${logo.id}/review`, "staff", {
      decision: "approve",
    });
    const summary = K.TasksSummary.parse(
      (await call(w, "GET", "/api/v2/account/tasks-summary", "admin")).data,
    );
    const mine = summary.find((s) => s.org_id === selfServe);
    // billing (locked) + sign (open) + logo (done); the withdrawn one is left out.
    expect(mine).toMatchObject({
      name: "Self Serve Co",
      account_stage: "customer",
      tasks_done: 1,
      tasks_total: 3,
    });
    expect(mine?.next_task_title).toBe("Review and sign the offer");
    // The billing role sees Gemeente Testdorp but not the self-serve org, where it has no role.
    expect(
      K.TasksSummary.parse(
        (await call(w, "GET", "/api/v2/account/tasks-summary", "billing")).data,
      ).map((s) => s.name),
    ).toEqual(["Gemeente Testdorp"]);
  });

  test("the summary's query has its indexes", async () => {
    const indexes = (await w.db.execute(
      sql`select indexname from pg_indexes where indexname in ('org_membership_user_id_index', 'account_task_org_id_status_index') order by indexname`,
    )) as unknown as { indexname: string }[];
    expect(indexes.map((i) => i.indexname)).toEqual([
      "account_task_org_id_status_index",
      "org_membership_user_id_index",
    ]);
  });
});
