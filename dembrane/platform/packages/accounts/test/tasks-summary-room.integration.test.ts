import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { newId } from "@dembrane/core";
import { schema } from "@dembrane/db";
import { and, eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import * as K from "../src/contract";
import { ensureUser } from "../src/prospect";
import { accountsRoutes } from "../src/routes";
import { store } from "../src/storage";
import { admin, call, dropDatabase, type World, world } from "./helpers";

// The signed-in person's summary, which the dashboard loads on every page: it lists the
// organisations whose account the caller runs, and those where a member was brought into
// the room, marked as room access. For a room the counts come only from what a room member
// reads (tasks on the offer and the DPA, billing details left out, as the account page
// does), and nothing waits on them: a room member reads, they do not act. Needs a scratch
// Postgres (TEST_DATABASE_ADMIN_URL).
const run = admin ? describe : describe.skip;
const DB = `accounts_summary_room_${process.pid}`;

type Who = keyof World["people"];
type Row = K.TasksSummaryT[number];

run("tasks summary with room access", () => {
  setDefaultTimeout(60_000);
  let w: World;
  const C = () => `/api/v2/orgs/${w.orgId}/account`;
  const S = () => `/api/v2/admin/accounts/${w.orgId}`;
  const colleague = "colleague" as Who;
  const owner = "owner" as Who;

  async function person(key: string, email: string, role?: string): Promise<Who> {
    const u = await w.db.transaction((tx) =>
      ensureUser(tx, { email, name: key, passwordHash: null, nowIso: w.clock.now.toISOString() }),
    );
    await w.db
      .update(schema.auth_user)
      .set({ emailVerified: true })
      .where(eq(schema.auth_user.id, u.userId));
    if (role)
      await w.db
        .insert(schema.org_membership)
        .values({ id: newId(), org_id: w.orgId, user_id: u.appUserId, role });
    (w.people as Record<string, unknown>)[key] = {
      appUserId: u.appUserId,
      directusUserId: u.userId,
      isStaff: false,
      email,
    };
    return key as Who;
  }

  const summary = async (as: Who) => {
    const r = await call(w, "GET", "/api/v2/account/tasks-summary", as);
    expect(r.status).toBe(200);
    return K.TasksSummary.parse(r.data);
  };
  const mine = async (as: Who): Promise<Row | undefined> =>
    (await summary(as)).find((o) => o.org_id === w.orgId);

  beforeAll(async () => {
    w = await world(DB, accountsRoutes);
    const pushed = await call(w, "POST", `${S()}/offers`, "staff", {
      template: "subscription",
      language: "nl",
      offer_name: "Gemeente Testdorp",
      person_name: "Anna",
      items: [
        { description: "Licentie", quantity: 12, unit_price_cents: 8600, vat_rate_bps: 2100 },
      ],
    });
    expect(pushed.status).toBe(201);
    const offerId = K.PushOfferResponse.parse(pushed.data).document.id;
    const dpaId = (await store.documents(w.db, w.orgId)).find((x) => x.kind === "dpa")?.id;
    expect(dpaId).toBeTruthy();
    const pdf = Buffer.from(await (await PDFDocument.create()).save()).toString("base64");
    const invoice = await call(w, "PUT", `${S()}/invoices/EX-SUM-1`, "staff", {
      number: "2026-0601",
      issued_on: "2026-09-28",
      due_on: "2026-10-28",
      subtotal_cents: 103200,
      vat_cents: 21672,
      total_cents: 124872,
      status: "open",
      offer_id: offerId,
      pdf_base64: pdf,
    });
    expect(invoice.status).toBe(200);
    const invoiceId = K.DocumentDetail.parse(invoice.data).id;
    // Tasks a room member must not be counted: one on the invoice, one with no document,
    // and the billing details one.
    for (const body of [
      { title: "Pay the first invoice", kind: "generic", document_id: invoiceId },
      { title: "Send us your logo", kind: "generic" },
      { title: "Fill in the billing details", kind: "billing_details" },
    ])
      expect((await call(w, "POST", `${S()}/tasks`, "staff", body)).status).toBe(201);
    await person("owner", "owner@example.test", "owner");
    await person("colleague", "colleague@example.test", "member");
    expect(
      (
        await call(w, "POST", `${C()}/room/people`, "admin", {
          email: "colleague@example.test",
          name: "Col League",
          labels: ["it_security"],
          other: null,
        })
      ).status,
    ).toBe(200);
    // Someone named to sign the DPA who is not a member.
    expect(
      (
        await call(w, "POST", `${C()}/documents/${dpaId}/signer`, "admin", {
          name: "Signer Person",
          email: "signer@example.test",
          role: null,
        })
      ).status,
    ).toBe(200);
  });
  afterAll(async () => {
    await w?.close();
    await dropDatabase(DB);
  });

  test("owners, admins and Billing see the account as they run it, with every task", async () => {
    const page = K.AccountPage.parse((await call(w, "GET", C(), "admin")).data);
    for (const as of [owner, "admin", "billing"] as Who[]) {
      const row = await mine(as);
      expect([as, row?.access]).toEqual([as, "account"]);
      expect(row?.tasks_total).toBe(page.tasks.length);
      expect(row?.tasks_waiting).toBeGreaterThan(0);
      expect(row?.next_task_code ?? row?.next_task_title).toBeTruthy();
    }
  });

  test("a room member sees the organisation as room access, counting only what they read", async () => {
    const row = await mine(colleague);
    expect(row?.access).toBe("room");
    expect(row?.name).toBe("Gemeente Testdorp");
    // The same tasks the account page gives them: those on the offer and the DPA.
    const page = K.AccountPage.parse((await call(w, "GET", C(), colleague)).data);
    expect(page.access).toBe("room");
    expect(page.tasks.length).toBeGreaterThan(0);
    expect(row?.tasks_total).toBe(page.tasks.length);
    expect(row?.tasks_done).toBe(page.tasks.filter((t) => t.status === "done").length);
    const all = K.AccountPage.parse((await call(w, "GET", C(), "admin")).data);
    expect(row?.tasks_total).toBeLessThan(all.tasks.length);
    // Nothing waits on a room member, so no prompt, no "Tasks" entry and no next task.
    expect(row?.tasks_waiting).toBe(0);
    expect([
      row?.next_task_title,
      row?.next_task_code,
      row?.next_task_params,
      row?.next_task_document_id,
      row?.next_task_document_kind,
    ]).toEqual([null, null, null, null, null]);
  });

  test("a plain member and a named signer who is not a member are not listed", async () => {
    expect(await mine("member")).toBeUndefined();
    expect(await mine("signer")).toBeUndefined();
    expect(await summary("outsider")).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ org_id: w.orgId })]),
    );
  });

  test("a room member who leaves the organisation drops out of the summary", async () => {
    const appUserId = w.people[colleague].appUserId as string;
    await w.db
      .update(schema.org_membership)
      .set({ deleted_at: w.clock.now.toISOString() })
      .where(
        and(
          eq(schema.org_membership.org_id, w.orgId),
          eq(schema.org_membership.user_id, appUserId),
        ),
      );
    expect(await mine(colleague)).toBeUndefined();
  });
});
