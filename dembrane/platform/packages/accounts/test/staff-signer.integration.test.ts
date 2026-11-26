import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PlatformError } from "@dembrane/core";
import { schema } from "@dembrane/db";
import { and, eq } from "drizzle-orm";
import * as K from "../src/contract";
import { accountsRoutes } from "../src/routes";
import { store } from "../src/storage";
import { admin, call, dropDatabase, pngB64, type World, world } from "./helpers";

// Staff name who signs for the customer: when they send an offer, or afterwards on an offer
// or a DPA still waiting. The person named is invited exactly as when the customer names
// them, so the sign-in step sends them a code at once. A staff key prepares and reads: where
// naming would email the signer, it is refused. Needs a scratch Postgres
// (TEST_DATABASE_ADMIN_URL).
const run = admin ? describe : describe.skip;
const DB = `accounts_staff_signer_${process.pid}`;

run("staff name the customer's signer", () => {
  setDefaultTimeout(60_000);
  let w: World;
  const C = () => `/api/v2/orgs/${w.orgId}/account`;
  const S = () => `/api/v2/admin/accounts/${w.orgId}`;
  const codeOf = (r: { data: unknown }) => (r.data as { code?: string }).code;
  const signerPath = (docId: string) => `${S()}/documents/${docId}/signer`;
  let n = 0;
  const offer = (over: Record<string, unknown> = {}) => ({
    template: "subscription",
    language: "nl",
    offer_name: "Gemeente Testdorp",
    person_name: "Anna",
    reference: `OFFER-STAFF-SIGNER-${++n}`,
    items: [{ description: "Licentie", quantity: 12, unit_price_cents: 8600, vat_rate_bps: 2100 }],
    ...over,
  });
  const push = async (over: Record<string, unknown> = {}, as: "staff" | "key" = "staff") =>
    call(w, "POST", `${S()}/offers`, as, offer(over));
  const pushed = async (over: Record<string, unknown> = {}) => {
    const r = await push(over);
    expect(r.status).toBe(201);
    return K.PushOfferResponse.parse(r.data).document;
  };

  /** What naming leaves behind for an address: the invitation and the signing email. */
  async function traces(email: string) {
    const invites = await w.db
      .select({ role: schema.org_invite.role })
      .from(schema.org_invite)
      .where(and(eq(schema.org_invite.org_id, w.orgId), eq(schema.org_invite.email, email)));
    const mails = w.jobs
      .of("account.send-email")
      .filter(
        (m) =>
          (m as { to?: string }).to === email &&
          (m as { template?: string }).template === "account_signer_invite",
      );
    return { invites: invites.map((i) => i.role), mails: mails.length };
  }
  const mayGetCode = (email: string) => store.mayReceiveCode(w.db, email, w.clock.now);
  const row = async (docId: string) => store.document(w.db, w.orgId, docId);
  const namings = async (docId: string) =>
    (await store.events(w.db, w.orgId)).filter(
      (e) => e.subjectId === docId && e.type.startsWith("document.signer_"),
    );
  /** The invitation token in the newest signing email to `email`. */
  const lastToken = (email: string) => {
    const mail = w.jobs
      .of("account.send-email")
      .filter((m) => (m as { to?: string }).to === email)
      .at(-1) as { data: { sign_url: string } } | undefined;
    return mail ? new URL(mail.data.sign_url).searchParams.get("invite") : null;
  };
  const waitingDpa = async () =>
    (await store.documents(w.db, w.orgId)).find(
      (x) => x.kind === "dpa" && ["sent", "viewed"].includes(x.status),
    );

  /** Fills and signs a document as `as`, from the document as they see it. */
  async function sign(docId: string, as: keyof World["people"], name: string) {
    const detail = K.DocumentDetail.parse(
      (await call(w, "GET", `${C()}/documents/${docId}`, as)).data,
    );
    const values: Record<string, string | boolean> = {};
    for (const f of detail.fields) {
      if (f.kind === "name") values[f.id] = name;
      else if (f.kind === "role") values[f.id] = "Wethouder";
      else if (f.kind === "date") values[f.id] = "28-09-2026";
      else if (f.kind === "checkbox") values[f.id] = true;
      else if (f.kind === "text" && f.key !== "po_number")
        values[f.id] = f.key === "organisation" ? "Testdorp" : "n/a";
    }
    return call(w, "POST", `${C()}/documents/${docId}/sign`, as, {
      sha256: detail.sha256,
      values,
      signature: { png_base64: pngB64(), method: "drawn" },
      initials: null,
      dpa_authorised: true,
      confirmation_text: (detail.confirmation?.dpa_authorised ?? "")
        .replace("{name}", name)
        .replace("{role}", "Wethouder")
        .replace("{organisation}", "Testdorp"),
    });
  }

  beforeAll(async () => {
    w = await world(DB, accountsRoutes);
    // The error code next to the text, so a refusal is checked for the right reason.
    w.app.onError((err, c) =>
      err instanceof PlatformError
        ? c.json({ detail: err.details ?? err.message, code: err.code }, err.status as 400)
        : c.json({ detail: String(err) }, 500),
    );
  });
  afterAll(async () => {
    await w?.close();
    await dropDatabase(DB);
  });

  test("an offer sent without a signer is as before: nobody named, nobody invited", async () => {
    w.jobs.jobs.length = 0;
    const doc = await pushed();
    expect(doc.signer).toBeNull();
    expect((await row(doc.id))?.signerEmail).toBeNull();
    expect(await namings(doc.id)).toEqual([]);
    expect(w.jobs.of("account.send-email").length).toBe(0);
  });

  test("an offer sent with its signer: they are invited and emailed, get a code at once, and show as its signer", async () => {
    w.jobs.jobs.length = 0;
    const email = "wethouder@testdorp.example";
    expect(await mayGetCode(email)).toBe(false);
    const doc = await pushed({
      customer_signer: {
        name: "Wil Wethouder",
        email: "Wethouder@Testdorp.example",
        role: "Wethouder",
      },
    });
    expect(doc.status).toBe("sent");
    expect(doc.signer).toMatchObject({ email, name: "Wil Wethouder", role: "Wethouder" });
    expect(doc.signer?.named_at).toBe(w.clock.now.toISOString());
    // Invited as a signer is: with the Billing role, and the signing email with its link.
    expect(await traces(email)).toEqual({ invites: ["billing"], mails: 1 });
    expect(lastToken(email)).toMatch(/^[\w-]{32}$/);
    expect(await mayGetCode(email)).toBe(true);
    // On the timeline, by staff.
    const events = await namings(doc.id);
    expect(events.map((e) => [e.type, e.actorKind])).toEqual([["document.signer_named", "staff"]]);
    // The customer sees who signs, on the document and in the room's list of signers.
    const seen = K.DocumentDetail.parse(
      (await call(w, "GET", `${C()}/documents/${doc.id}`, "admin")).data,
    );
    expect(seen.signer?.email).toBe(email);
    const room = K.RoomPage.parse((await call(w, "GET", `${C()}/room`, "admin")).data);
    expect([room.signers.offer?.email, room.signers.offer?.document_id]).toEqual([email, doc.id]);
    // The invitation page greets them; staff are not "from" the customer, so it names no one.
    const invite = K.SignerInvite.parse(
      (await call(w, "GET", `${C()}/documents/${doc.id}/invite?invite=${lastToken(email)}`, null))
        .data,
    );
    expect(invite.signer.email).toBe(email);
    expect(invite.inviter).toBeNull();
  });

  test("a draft keeps the signer staff gave and invites them only when it is sent", async () => {
    w.jobs.jobs.length = 0;
    const email = "griffier@testdorp.example";
    const draft = await pushed({
      send: false,
      customer_signer: { name: "Greet Griffier", email, role: null },
    });
    expect(draft.status).toBe("draft");
    expect(draft.signer).toMatchObject({ email, name: "Greet Griffier", named_at: null });
    expect(await traces(email)).toEqual({ invites: [], mails: 0 });
    expect(await mayGetCode(email)).toBe(false);

    // A change to the draft may name someone else; absent keeps the draft's.
    const other = "secretaris@testdorp.example";
    const changed = await call(w, "PUT", `${S()}/offers/${draft.id}`, "staff", {
      ...offer(),
      reference: draft.reference,
      customer_signer: { name: "Sam Secretaris", email: other, role: "Secretaris" },
    });
    expect(changed.status).toBe(200);
    expect(K.DocumentDetail.parse(changed.data).signer?.email).toBe(other);
    const kept = await call(w, "PUT", `${S()}/offers/${draft.id}`, "staff", {
      ...offer(),
      reference: draft.reference,
    });
    expect(K.DocumentDetail.parse(kept.data).signer?.email).toBe(other);
    expect(await traces(other)).toEqual({ invites: [], mails: 0 });

    const sent = await call(w, "POST", `${S()}/documents/${draft.id}/send`, "staff", {});
    expect(sent.status).toBe(200);
    expect(K.DocumentDetail.parse(sent.data).signer?.named_at).toBe(w.clock.now.toISOString());
    expect(await traces(other)).toEqual({ invites: ["billing"], mails: 1 });
    expect(await mayGetCode(other)).toBe(true);
    expect(await traces(email)).toEqual({ invites: [], mails: 0 });

    // Null drops the draft's signer.
    const again = await pushed({ send: false, customer_signer: { name: "X", email, role: null } });
    const dropped = await call(w, "PUT", `${S()}/offers/${again.id}`, "staff", {
      ...offer(),
      reference: again.reference,
      customer_signer: null,
    });
    expect(K.DocumentDetail.parse(dropped.data).signer).toBeNull();
  });

  test("a staff key drafts with a signer, but never names one where that emails them", async () => {
    w.jobs.jobs.length = 0;
    const email = "key-named@testdorp.example";
    const signer = { name: "Key Named", email, role: null };
    const before = (await store.documents(w.db, w.orgId)).length;
    const refused = await push({ customer_signer: signer }, "key");
    expect([refused.status, codeOf(refused)]).toEqual([403, "staff.key_cannot_email"]);
    expect((await store.documents(w.db, w.orgId)).length).toBe(before);

    const drafted = await push({ send: false, customer_signer: signer }, "key");
    expect(drafted.status).toBe(201);
    const draft = K.PushOfferResponse.parse(drafted.data).document;
    const send = await call(w, "POST", `${S()}/documents/${draft.id}/send`, "key", {});
    expect([send.status, codeOf(send)]).toEqual([403, "staff.key_cannot_email"]);
    expect((await row(draft.id))?.status).toBe("draft");

    const waiting = await pushed();
    const set = await call(w, "POST", signerPath(waiting.id), "key", signer);
    expect([set.status, codeOf(set)]).toEqual([403, "staff.key_cannot_email"]);
    expect((await row(waiting.id))?.signerEmail).toBeNull();
    expect(await traces(email)).toEqual({ invites: [], mails: 0 });
  });

  test("staff set the signer on an offer with none, and on its DPA; the action is audited and on the timeline", async () => {
    w.jobs.jobs.length = 0;
    const doc = await pushed();
    const email = "inkoper@testdorp.example";
    const audited = () =>
      w.db
        .select()
        .from(schema.staff_audit_event)
        .where(eq(schema.staff_audit_event.action, "accounts.document.signer.set"))
        .orderBy(schema.staff_audit_event.createdAt);
    // The staff key's refused attempt above is on the audit trail already.
    const before = (await audited()).length;
    const r = await call(w, "POST", signerPath(doc.id), "staff", {
      name: "Ina Inkoper",
      email,
      role: "Inkoper",
    });
    expect(r.status).toBe(200);
    expect(K.NameSignerResponse.parse(r.data).signer).toMatchObject({
      email,
      name: "Ina Inkoper",
      role: "Inkoper",
      named_at: w.clock.now.toISOString(),
    });
    expect((await row(doc.id))?.signerEmail).toBe(email);
    expect(await traces(email)).toEqual({ invites: ["billing"], mails: 1 });
    expect(await mayGetCode(email)).toBe(true);
    const audit = (await audited()).slice(before);
    expect(audit.map((a) => [a.permission, a.targetType, a.targetId])).toEqual([
      ["staff:accounts", "org", w.orgId],
    ]);
    const events = await namings(doc.id);
    expect(events.map((e) => [e.type, e.actorKind, e.actorUserId])).toEqual([
      ["document.signer_named", "staff", w.people.staff.directusUserId],
    ]);

    const dpa = await waitingDpa();
    expect(dpa).toBeDefined();
    const onDpa = await call(w, "POST", signerPath(dpa?.id as string), "staff", {
      name: "Fien Functionaris",
      email: "fg@testdorp.example",
      role: null,
    });
    expect(onDpa.status).toBe(200);
    expect((await row(dpa?.id as string))?.signerEmail).toBe("fg@testdorp.example");
  });

  test("staff change the signer: one signer per document, and the earlier link stops working", async () => {
    const doc = await pushed({
      customer_signer: { name: "Eerste", email: "eerste@testdorp.example", role: null },
    });
    const first = lastToken("eerste@testdorp.example") as string;
    const invite = (token: string) =>
      call(w, "GET", `${C()}/documents/${doc.id}/invite?invite=${token}`, null);
    expect((await invite(first)).status).toBe(200);
    w.clock.now = new Date(w.clock.now.getTime() + 60_000);
    const r = await call(w, "POST", signerPath(doc.id), "staff", {
      name: "Tweede",
      email: "tweede@testdorp.example",
      role: null,
    });
    expect(r.status).toBe(200);
    expect((await row(doc.id))?.signerEmail).toBe("tweede@testdorp.example");
    expect((await invite(first)).status).toBe(404);
    expect((await invite(lastToken("tweede@testdorp.example") as string)).status).toBe(200);
    expect(await mayGetCode("tweede@testdorp.example")).toBe(true);
    const events = await namings(doc.id);
    expect(events.map((e) => e.type).sort()).toEqual([
      "document.signer_named",
      "document.signer_replaced",
    ]);
    const replaced = events.find((e) => e.type === "document.signer_replaced");
    expect(replaced?.detail).toMatchObject({
      email: "tweede@testdorp.example",
      previous_email: "eerste@testdorp.example",
    });
  });

  test("naming the same person again sends nothing and keeps their link; a new name or job title is kept", async () => {
    const email = "zelfde@testdorp.example";
    const doc = await pushed({ customer_signer: { name: "Zelfde", email, role: null } });
    const token = lastToken(email) as string;
    const invite = (t: string) =>
      call(w, "GET", `${C()}/documents/${doc.id}/invite?invite=${t}`, null);
    const before = { traces: await traces(email), namings: (await namings(doc.id)).length };
    w.clock.now = new Date(w.clock.now.getTime() + 60_000);
    const staff = await call(w, "POST", signerPath(doc.id), "staff", {
      name: "Zelfde Persoon",
      email,
      role: "Wethouder",
    });
    expect(staff.status).toBe(200);
    const own = await call(w, "POST", `${C()}/documents/${doc.id}/signer`, "admin", {
      name: "Zelfde Persoon",
      email,
      role: "Wethouder",
    });
    expect(own.status).toBe(200);
    expect(await traces(email)).toEqual(before.traces);
    expect((await namings(doc.id)).length).toBe(before.namings);
    expect((await invite(token)).status).toBe(200);
    const after = await row(doc.id);
    expect([after?.signerName, after?.signerRole]).toEqual(["Zelfde Persoon", "Wethouder"]);
  });

  test("a signer taken off loses the invitation their naming made, unless they have another reason to come in", async () => {
    const pending = async (email: string) =>
      Boolean(await store.pendingOrgInvite(w.db, w.orgId, email, w.clock.now));
    const rename = (docId: string, email: string) =>
      call(w, "POST", signerPath(docId), "staff", { name: email, email, role: null });
    const signer = (email: string) => ({ customer_signer: { name: email, email, role: null } });

    // Replaced: the invitation the naming made goes with it.
    const replaced = await pushed(signer("weg@testdorp.example"));
    expect(await pending("weg@testdorp.example")).toBe(true);
    expect((await rename(replaced.id, "opvolger@testdorp.example")).status).toBe(200);
    expect(await pending("weg@testdorp.example")).toBe(false);
    expect(await pending("opvolger@testdorp.example")).toBe(true);

    // Still named on another document: the invitation stays.
    const one = await pushed(signer("dubbel@testdorp.example"));
    const two = await pushed();
    expect((await rename(two.id, "dubbel@testdorp.example")).status).toBe(200);
    expect((await rename(one.id, "ander@testdorp.example")).status).toBe(200);
    expect(await pending("dubbel@testdorp.example")).toBe(true);

    // Invited by an admin before the naming: not the naming's to take back.
    await store.inviteToOrg(w.db, {
      id: crypto.randomUUID(),
      orgId: w.orgId,
      email: "eigen@testdorp.example",
      role: "billing",
      invitedBy: null,
      now: w.clock.now,
    });
    const own = await pushed(signer("eigen@testdorp.example"));
    expect((await rename(own.id, "nog-een@testdorp.example")).status).toBe(200);
    expect(await pending("eigen@testdorp.example")).toBe(true);

    // In the room for what they do: the room keeps them invited.
    const room = await pushed(signer("kamer@testdorp.example"));
    const added = await call(w, "POST", `${C()}/room/people`, "admin", {
      email: "kamer@testdorp.example",
      name: "Kamer Lid",
      labels: ["it_security"],
      other: null,
    });
    expect(added.status).toBeLessThan(300);
    expect((await rename(room.id, "weer-een@testdorp.example")).status).toBe(200);
    expect(await pending("kamer@testdorp.example")).toBe(true);

    // The admin answers that they sign themselves: the named person's invitation goes.
    const mine = await pushed(signer("ikteken@testdorp.example"));
    const task = (await store.tasks(w.db, w.orgId)).find(
      (t) => t.code === "who_signs" && t.documentId === mine.id,
    );
    const answered = await call(w, "POST", `${C()}/tasks/${task?.id}/who-signs`, "admin", {
      offer_signer: null,
      dpa_same: true,
      dpa_signer: null,
      dpia: false,
    });
    expect(answered.status).toBe(200);
    expect((await row(mine.id))?.signerEmail).toBeNull();
    expect(await pending("ikteken@testdorp.example")).toBe(false);
  });

  test("the invitation page of a staff naming names nobody as from the customer's organisation", async () => {
    const doc = await pushed({
      customer_signer: { name: "Pagina", email: "pagina@testdorp.example", role: null },
    });
    const page = await call(
      w,
      "GET",
      `${C()}/documents/${doc.id}/invite?invite=${lastToken("pagina@testdorp.example")}`,
      null,
    );
    expect(page.status).toBe(200);
    expect((page.data as { inviter: unknown }).inviter).toBeNull();
    // A naming by the customer's admin keeps their name on it.
    w.clock.now = new Date(w.clock.now.getTime() + 60_000);
    expect(
      (
        await call(w, "POST", `${C()}/documents/${doc.id}/signer`, "admin", {
          name: "Klant Keuze",
          email: "klantkeuze@testdorp.example",
          role: null,
        })
      ).status,
    ).toBe(200);
    const theirs = await call(
      w,
      "GET",
      `${C()}/documents/${doc.id}/invite?invite=${lastToken("klantkeuze@testdorp.example")}`,
      null,
    );
    expect((theirs.data as { inviter: { name: string } | null }).inviter?.name).toBeTruthy();
  });

  test("a signed document keeps its signer: staff are refused and nothing changes", async () => {
    const doc = await pushed();
    expect((await sign(doc.id, "billing", "Bram Jansen")).status).toBe(200);
    expect((await row(doc.id))?.status).toBe("signed");
    w.jobs.jobs.length = 0;
    const r = await call(w, "POST", signerPath(doc.id), "staff", {
      name: "Te Laat",
      email: "laat@testdorp.example",
      role: null,
    });
    expect([r.status, codeOf(r)]).toEqual([409, "document.not_awaiting_signature"]);
    expect((await row(doc.id))?.signerEmail).toBeNull();
    expect(await traces("laat@testdorp.example")).toEqual({ invites: [], mails: 0 });
  });

  test("only staff reach the staff route; the customer's own rules stay theirs", async () => {
    const doc = await pushed();
    const who = { name: "Niet Staff", email: "niet@testdorp.example", role: null };
    for (const as of ["admin", "billing", "member", "outsider", "signer"] as const) {
      const r = await call(w, "POST", signerPath(doc.id), as, who);
      expect(r.status).toBe(403);
    }
    expect((await row(doc.id))?.signerEmail).toBeNull();
    // Billing still may not name anyone on the customer's own route.
    const billing = await call(w, "POST", `${C()}/documents/${doc.id}/signer`, "billing", who);
    expect([billing.status, codeOf(billing)]).toEqual([403, "room.name_signer_admins_only"]);
    // Unknown documents and drafts read as not found.
    const draft = await pushed({ send: false });
    expect((await call(w, "POST", signerPath(draft.id), "staff", who)).status).toBe(404);
    expect(
      (await call(w, "POST", signerPath("00000000-0000-4000-8000-000000000000"), "staff", who))
        .status,
    ).toBe(404);
  });

  test("staff namings do not use up the organisation's own namings", async () => {
    // A fresh hour, so the namings above count for nothing here.
    w.clock.now = new Date(w.clock.now.getTime() + 2 * 3600_000);
    const doc = await pushed();
    for (let i = 0; i < 11; i++) {
      const r = await call(w, "POST", signerPath(doc.id), "staff", {
        name: `Staff ${i}`,
        email: `staff-named-${i}@testdorp.example`,
        role: null,
      });
      expect(r.status).toBe(200);
    }
    // The customer's admin still names someone: their ten an hour are untouched.
    const own = await call(w, "POST", `${C()}/documents/${doc.id}/signer`, "admin", {
      name: "Eigen Keuze",
      email: "eigen@testdorp.example",
      role: null,
    });
    expect(own.status).toBe(200);
    expect((await row(doc.id))?.signerEmail).toBe("eigen@testdorp.example");
  });
});
