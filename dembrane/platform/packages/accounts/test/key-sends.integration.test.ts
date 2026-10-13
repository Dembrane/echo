import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { sendEmail } from "@dembrane/account";
import { newId } from "@dembrane/core";
import { schema } from "@dembrane/db";
import { eq } from "drizzle-orm";
import * as K from "../src/contract";
import { freshSteps } from "../src/demo/build";
import { accountsRoutes } from "../src/routes";
import { store } from "../src/storage";
import { admin, call, dropDatabase, type World, world } from "./helpers";

// An email to a customer leaves on a person's own action. A staff API key prepares and
// reads through the same routes; each call that would queue an email is refused for it
// and changes nothing, while a signed-in staff member's call works as before.
const run = admin ? describe : describe.skip;
const DB = `accounts_key_sends_${process.pid}`;

run("a staff key never causes an email", () => {
  setDefaultTimeout(60_000);
  let w: World;
  const S = () => `/api/v2/admin/accounts/${w.orgId}`;
  const emails = () => w.jobs.of(sendEmail.name).length;
  const refused = (r: { status: number; data: unknown }) => {
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.data)).toContain("staff key");
  };
  const offer = (as: "staff" | "key", over: Record<string, unknown> = {}) =>
    call(w, "POST", `${S()}/offers`, as, {
      template: "subscription",
      language: "en",
      offer_name: "Gemeente Testdorp",
      person_name: "Anna",
      items: [{ description: "Licence", quantity: 1, unit_price_cents: 1000, vat_rate_bps: 2100 }],
      ...over,
    });
  const documentCount = async () => (await store.documents(w.db, w.orgId)).length;

  beforeAll(async () => {
    w = await world(DB, accountsRoutes);
  });
  afterAll(async () => {
    await w?.close();
    await dropDatabase(DB);
  });

  test("an offer: the key drafts and changes it, only a person sends it", async () => {
    const before = await documentCount();
    // Sending is the default of a push, so the key has to ask for a draft.
    refused(await offer("key"));
    expect(await documentCount()).toBe(before);

    const drafted = await offer("key", { send: false });
    expect(drafted.status).toBe(201);
    const doc = K.PushOfferResponse.parse(drafted.data).document;
    expect(doc.status).toBe("draft");

    refused(await call(w, "POST", `${S()}/documents/${doc.id}/send`, "key", {}));
    const still = await store.document(w.db, w.orgId, doc.id);
    expect(still?.status).toBe("draft");
    expect(still?.sentAt).toBeNull();
    expect((await store.tasks(w.db, w.orgId)).some((t) => t.documentId === doc.id)).toBe(false);
    expect(emails()).toBe(0);

    const sent = await call(w, "POST", `${S()}/documents/${doc.id}/send`, "staff", {});
    expect(sent.status).toBe(200);
    expect((await store.document(w.db, w.orgId, doc.id))?.status).toBe("sent");
    expect(emails()).toBeGreaterThan(0);
  });

  test("a document that is not an offer emails nobody, so the key may send it", async () => {
    const before = emails();
    const pushed = await call(w, "POST", `${S()}/documents`, "key", {
      kind: "other",
      title: "House rules",
      body: "Be kind.",
      requires_signature: false,
    });
    expect(pushed.status).toBe(201);
    expect(emails()).toBe(before);
  });

  test("a message: the key sees the preview, only a person sends", async () => {
    const withdrawn = K.PushOfferResponse.parse(
      (await offer("staff", { send: false })).data,
    ).document;
    await call(w, "POST", `${S()}/documents/${withdrawn.id}/void`, "staff", {});
    const body = { kind: "document_withdrawn", document_id: withdrawn.id };
    const before = emails();

    const preview = await call(w, "POST", `${S()}/messages`, "key", { ...body, dry_run: true });
    expect(preview.status).toBe(200);
    expect(K.SendMessageResponse.parse(preview.data).queued).toBe(0);

    refused(await call(w, "POST", `${S()}/messages`, "key", body));
    expect(emails()).toBe(before);

    const sent = await call(w, "POST", `${S()}/messages`, "staff", body);
    expect(sent.status).toBe(200);
    expect(K.SendMessageResponse.parse(sent.data).queued).toBeGreaterThan(0);
    expect(emails()).toBeGreaterThan(before);
  });

  test("a demo: the key publishes without an invitation, only a person invites", async () => {
    const draft = async (signIn: boolean) => {
      const id = newId();
      await w.db.insert(schema.account_demo).values({
        id,
        status: "draft",
        input: {
          organisation_name: "Gemeente Voorbeeldstad",
          website_url: "https://www.voorbeeldstad.example/",
          brief: null,
          language: "nl",
          contact_name: "Anna de Vries",
          contact_email: "anna@voorbeeldstad.example",
          sign_in: signIn,
          offer: null,
        },
        steps: freshSteps(),
        seed: { workspace_id: newId(), projects: [], links: {}, continue_url: "https://dash.test" },
        createdBy: w.people.staff.directusUserId,
      });
      return id;
    };
    const status = async (id: string) =>
      (await w.db.select().from(schema.account_demo).where(eq(schema.account_demo.id, id)))[0];
    const publish = (id: string, as: "staff" | "key", body: Record<string, unknown>) =>
      call(w, "POST", `/api/v2/admin/accounts/demos/${id}/publish`, as, body);
    const before = emails();

    // The invitation chosen at publish, and the one the demo was made with.
    const asked = await draft(false);
    refused(await publish(asked, "key", { sign_in: true }));
    const made = await draft(true);
    refused(await publish(made, "key", {}));
    for (const id of [asked, made]) {
      expect((await status(id))?.status).toBe("draft");
      expect((await status(id))?.invitedAt).toBeNull();
    }
    expect(emails()).toBe(before);

    // Without the invitation the key publishes: the page goes live and nobody is written.
    expect((await publish(made, "key", { sign_in: false })).status).toBe(200);
    expect((await status(made))?.status).toBe("published");
    expect((await status(made))?.invitedAt).toBeNull();
    expect(emails()).toBe(before);

    // A person's publish with the invitation sends it, as before.
    expect((await publish(asked, "staff", { sign_in: true })).status).toBe(200);
    expect((await status(asked))?.invitedAt).not.toBeNull();
    expect(emails()).toBe(before + 1);
  });
});
