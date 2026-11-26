import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { newId, PlatformError } from "@dembrane/core";
import { schema } from "@dembrane/db";
import { and, eq } from "drizzle-orm";
import * as K from "../src/contract";
import { ensureUser } from "../src/prospect";
import { accountsRoutes } from "../src/routes";
import { store } from "../src/storage";
import { admin, call, dropDatabase, pngB64, type World, world } from "./helpers";

// Naming a signer who is not a member also invites them into the organisation (Billing).
// When they are replaced or taken off before they accepted, that invitation is withdrawn
// too, unless something else still brings them in: another document waiting on them, the
// data room, or an invitation made another way. Someone who accepted keeps their membership.
// Every path that changes who signs goes through setSigner and unsetSigner, so each is
// checked here: the customer's naming, their "I sign" answer, the staff route, an offer sent
// with its signer, a draft's signer, and taking someone out of the room. Needs a scratch
// Postgres (TEST_DATABASE_ADMIN_URL).
const run = admin ? describe : describe.skip;
const DB = `accounts_signer_invitation_${process.pid}`;

run("a replaced signer's invitation", () => {
  setDefaultTimeout(60_000);
  let w: World;
  const C = () => `/api/v2/orgs/${w.orgId}/account`;
  const S = () => `/api/v2/admin/accounts/${w.orgId}`;
  let n = 0;
  /** A fresh address with no account, so only an invitation or a naming gives it a code. */
  const fresh = (who: string) => `${who}-${++n}@testdorp.example`;
  const person = (email: string) => ({ name: email.split("@")[0] as string, email, role: null });

  const offer = (over: Record<string, unknown> = {}) => ({
    template: "subscription",
    language: "nl",
    offer_name: "Gemeente Testdorp",
    person_name: "Anna",
    reference: `OFFER-SIGNER-INVITE-${++n}`,
    items: [{ description: "Licentie", quantity: 12, unit_price_cents: 8600, vat_rate_bps: 2100 }],
    ...over,
  });
  const pushed = async (over: Record<string, unknown> = {}) => {
    const r = await call(w, "POST", `${S()}/offers`, "staff", offer(over));
    expect(r.status).toBe(201);
    return K.PushOfferResponse.parse(r.data).document;
  };
  /** The customer's admin names someone (the documents route). */
  const customerNames = async (docId: string, email: string) => {
    const r = await call(w, "POST", `${C()}/documents/${docId}/signer`, "admin", person(email));
    expect(r.status).toBe(200);
  };
  /** Staff name someone (the staff route). */
  const staffNames = async (docId: string, email: string) => {
    const r = await call(w, "POST", `${S()}/documents/${docId}/signer`, "staff", person(email));
    expect(r.status).toBe(200);
  };
  const whoSignsTask = async (docId: string) =>
    (await store.tasks(w.db, w.orgId)).find(
      (t) => t.code === "who_signs" && t.documentId === docId,
    );
  /** The newest DPA waiting for a signature: read right after the offer it came with. */
  const waitingDpa = async () =>
    (await store.documents(w.db, w.orgId))
      .filter((x) => x.kind === "dpa" && ["sent", "viewed"].includes(x.status))
      .at(-1);
  const addToRoom = async (email: string) => {
    const r = await call(w, "POST", `${C()}/room/people`, "admin", {
      email,
      name: "Kamer Lid",
      labels: ["it_security"],
      other: null,
    });
    expect(r.status).toBeLessThan(300);
    return (await store.roomPersonByEmail(w.db, w.orgId, email))?.id as string;
  };
  const takeOutOfRoom = async (id: string) => {
    const r = await call(w, "POST", `${C()}/room/people/${id}/remove`, "admin", {});
    expect(r.status).toBeLessThan(300);
  };

  const pending = (email: string) => store.pendingOrgInvite(w.db, w.orgId, email, w.clock.now);
  const mayGetCode = (email: string) => store.mayReceiveCode(w.db, email, w.clock.now);
  /** The invitation token in the newest signing email to `email`. */
  const lastToken = (email: string) => {
    const mail = w.jobs
      .of("account.send-email")
      .filter((m) => (m as { to?: string }).to === email)
      .at(-1) as { data: { sign_url: string } } | undefined;
    return mail ? (new URL(mail.data.sign_url).searchParams.get("invite") as string) : null;
  };
  const linkStatus = async (docId: string, token: string) =>
    (await call(w, "GET", `${C()}/documents/${docId}/invite?invite=${token}`, null)).status;
  const signerEvents = async (docId: string) =>
    (await store.events(w.db, w.orgId)).filter(
      (e) => e.subjectId === docId && e.type.startsWith("document.signer_"),
    );

  /** The address no longer comes in: no invitation waiting, its old link refused, no code. */
  async function shutOut(email: string, docId: string, token: string) {
    expect(await pending(email)).toBeNull();
    expect(await linkStatus(docId, token)).toBe(404);
    expect(await mayGetCode(email)).toBe(false);
  }
  /** The address is named and invited: an invitation waits, its link opens, it gets a code. */
  async function standing(email: string, docId: string) {
    expect((await pending(email))?.role).toBe("billing");
    expect(await linkStatus(docId, lastToken(email) as string)).toBe(200);
    expect(await mayGetCode(email)).toBe(true);
  }

  /** Someone with a verified account and no membership, signed in as "late". */
  async function signedIn(email: string) {
    const u = await w.db.transaction((tx) =>
      ensureUser(tx, { email, name: "Late Signer", passwordHash: null, nowIso: iso(w) }),
    );
    await w.db
      .update(schema.auth_user)
      .set({ emailVerified: true })
      .where(eq(schema.auth_user.id, u.userId));
    (w.people as Record<string, unknown>).late = {
      appUserId: u.appUserId,
      directusUserId: u.userId,
      isStaff: false,
      email,
    };
    return email;
  }
  const iso = (x: World) => x.clock.now.toISOString();

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
    w.app.onError((err, c) =>
      err instanceof PlatformError
        ? c.json({ detail: err.details ?? err.message, code: err.code }, err.status as 400)
        : c.json({ detail: String(err) }, 500),
    );
  });
  // An hour on each time, so the customer's namings per hour never run out.
  beforeEach(() => {
    w.clock.now = new Date(w.clock.now.getTime() + 3_700_000);
  });
  afterAll(async () => {
    await w?.close();
    await dropDatabase(DB);
  });

  // ── every path that changes who signs ─────────────────────────────────

  test("the customer names someone else: A's invitation is withdrawn, B is invited, and the timeline records it", async () => {
    const [a, b] = [fresh("a"), fresh("b")];
    const doc = await pushed();
    await customerNames(doc.id, a);
    const invite = (await pending(a))?.id as string;
    const token = lastToken(a) as string;
    await standing(a, doc.id);
    await customerNames(doc.id, b);
    await shutOut(a, doc.id, token);
    await standing(b, doc.id);
    const replaced = (await signerEvents(doc.id)).find(
      (e) => e.type === "document.signer_replaced",
    );
    expect(replaced?.detail).toMatchObject({
      email: b,
      previous_email: a,
      withdrawn_invite_ids: [invite],
    });
  });

  test('the customer answers "I sign": A\'s invitation is withdrawn and the timeline records it', async () => {
    const a = fresh("a");
    const doc = await pushed({ customer_signer: person(a) });
    const invite = (await pending(a))?.id as string;
    const token = lastToken(a) as string;
    const task = await whoSignsTask(doc.id);
    const r = await call(w, "POST", `${C()}/tasks/${task?.id}/who-signs`, "admin", {
      offer_signer: null,
      dpa_same: true,
      dpa_signer: null,
      dpia: false,
    });
    expect(r.status).toBe(200);
    expect((await store.document(w.db, w.orgId, doc.id))?.signerEmail).toBeNull();
    await shutOut(a, doc.id, token);
    const removed = (await signerEvents(doc.id)).find((e) => e.type === "document.signer_removed");
    expect(removed?.detail).toMatchObject({ previous_email: a, withdrawn_invite_ids: [invite] });
  });

  test("staff set the signer and then change it: A's invitation is withdrawn, recorded as staff's", async () => {
    const [a, b] = [fresh("a"), fresh("b")];
    const doc = await pushed();
    await staffNames(doc.id, a);
    const invite = (await pending(a))?.id as string;
    const token = lastToken(a) as string;
    await standing(a, doc.id);
    await staffNames(doc.id, b);
    await shutOut(a, doc.id, token);
    await standing(b, doc.id);
    const replaced = (await signerEvents(doc.id)).find(
      (e) => e.type === "document.signer_replaced",
    );
    expect(replaced?.actorKind).toBe("staff");
    expect(replaced?.detail).toMatchObject({ withdrawn_invite_ids: [invite] });
  });

  test("an offer sent with its signer, then changed by staff: A's invitation is withdrawn", async () => {
    const [a, b] = [fresh("a"), fresh("b")];
    const doc = await pushed({ customer_signer: person(a) });
    const token = lastToken(a) as string;
    await standing(a, doc.id);
    await staffNames(doc.id, b);
    await shutOut(a, doc.id, token);
    await standing(b, doc.id);
  });

  test("a draft's signer changed or cleared before it is sent: nobody was invited, so nothing is left", async () => {
    const [a, b, c] = [fresh("a"), fresh("b"), fresh("c")];
    const draft = await pushed({ send: false, customer_signer: person(a) });
    const changed = await call(w, "PUT", `${S()}/offers/${draft.id}`, "staff", {
      ...offer(),
      reference: draft.reference,
      customer_signer: person(b),
    });
    expect(changed.status).toBe(200);
    const sent = await call(w, "POST", `${S()}/documents/${draft.id}/send`, "staff", {});
    expect(sent.status).toBe(200);
    expect(await pending(a)).toBeNull();
    expect(await mayGetCode(a)).toBe(false);
    await standing(b, draft.id);

    const other = await pushed({ send: false, customer_signer: person(c) });
    const cleared = await call(w, "PUT", `${S()}/offers/${other.id}`, "staff", {
      ...offer(),
      reference: other.reference,
      customer_signer: null,
    });
    expect(cleared.status).toBe(200);
    expect((await call(w, "POST", `${S()}/documents/${other.id}/send`, "staff", {})).status).toBe(
      200,
    );
    expect(await pending(c)).toBeNull();
    expect(await mayGetCode(c)).toBe(false);
    expect((await store.document(w.db, w.orgId, other.id))?.signerEmail).toBeNull();
  });

  test("named, then in the room, then replaced: the room keeps them in; taken out of the room, the naming's invitation goes too", async () => {
    const [a, b] = [fresh("a"), fresh("b")];
    const doc = await pushed({ customer_signer: person(a) });
    const token = lastToken(a) as string;
    // The room keeps the invitation the naming made (one per address).
    const roomRow = await addToRoom(a);
    await staffNames(doc.id, b);
    expect(await pending(a)).not.toBeNull();
    expect(await mayGetCode(a)).toBe(true);
    // Out of the room and no longer named: nothing brings them in.
    await takeOutOfRoom(roomRow);
    await shutOut(a, doc.id, token);
    await standing(b, doc.id);
  });

  test("taken out of the room while still named: they keep signing; replaced afterwards, that invitation goes", async () => {
    const [a, b] = [fresh("a"), fresh("b")];
    const roomRow = await addToRoom(a);
    const doc = await pushed({ customer_signer: person(a) });
    await takeOutOfRoom(roomRow);
    await standing(a, doc.id);
    const token = lastToken(a) as string;
    await staffNames(doc.id, b);
    await shutOut(a, doc.id, token);
  });

  // ── what else keeps them in ───────────────────────────────────────────

  test("still named on the DPA: replaced on the offer, they keep the invitation; replaced on the DPA too, it goes", async () => {
    const [a, b, c] = [fresh("a"), fresh("b"), fresh("c")];
    const doc = await pushed({ customer_signer: person(a) });
    const dpa = await waitingDpa();
    expect(dpa).toBeDefined();
    const dpaId = dpa?.id as string;
    await staffNames(dpaId, a);
    await staffNames(doc.id, b);
    await standing(a, dpaId);
    const token = lastToken(a) as string;
    await staffNames(dpaId, c);
    await shutOut(a, dpaId, token);
  });

  test("in the data room first: replaced as signer, the room's invitation stays", async () => {
    const [a, b] = [fresh("a"), fresh("b")];
    await addToRoom(a);
    const roomInvite = (await pending(a))?.id;
    const doc = await pushed({ customer_signer: person(a) });
    await staffNames(doc.id, b);
    expect((await pending(a))?.id).toBe(roomInvite as string);
    expect(await mayGetCode(a)).toBe(true);
  });

  test("a room row without access (labels only) does not keep the naming's invitation", async () => {
    const [a, b] = [fresh("a"), fresh("b")];
    const doc = await pushed({ customer_signer: person(a) });
    const token = lastToken(a) as string;
    // As left behind by someone in by their role who has since left the organisation.
    await w.db.insert(schema.account_room_person).values({
      id: newId(),
      orgId: w.orgId,
      email: a,
      name: "Labels Only",
      labels: ["rollout"],
      accessGrantedAt: null,
    });
    await staffNames(doc.id, b);
    await shutOut(a, doc.id, token);
  });

  test("invited from the Members page first, then named: replaced, the Members invitation stays", async () => {
    const [a, b] = [fresh("a"), fresh("b")];
    // As the Members page makes one: the role the admin chose, the admin as inviter.
    const membersInvite = newId();
    await w.db.insert(schema.org_invite).values({
      id: membersInvite,
      org_id: w.orgId,
      email: a,
      role: "member",
      invited_by: w.people.admin.appUserId as string,
      expires_at: new Date(w.clock.now.getTime() + 7 * 86_400_000).toISOString(),
    });
    const doc = await pushed();
    await customerNames(doc.id, a);
    await customerNames(doc.id, b);
    expect((await pending(a))?.id).toBe(membersInvite);
    expect((await pending(a))?.role).toBe("member");
    expect(await mayGetCode(a)).toBe(true);
    const replaced = (await signerEvents(doc.id)).find(
      (e) => e.type === "document.signer_replaced",
    );
    expect(replaced?.detail).toMatchObject({ withdrawn_invite_ids: [] });
  });

  test("someone who already accepted keeps their membership and role when replaced", async () => {
    const signer = w.people.signer.email;
    const b = fresh("b");
    const doc = await pushed({ customer_signer: person(signer) });
    const dpa = await waitingDpa();
    const dpaId = dpa?.id as string;
    await staffNames(dpaId, signer);
    // Signing the offer takes up the invitation: they join with the Billing role.
    expect((await sign(doc.id, "signer", "Signer Person")).status).toBe(200);
    const membership = async () =>
      (
        await w.db
          .select()
          .from(schema.org_membership)
          .where(
            and(
              eq(schema.org_membership.org_id, w.orgId),
              eq(schema.org_membership.user_id, w.people.signer.appUserId as string),
            ),
          )
      )[0];
    expect((await membership())?.role).toBe("billing");
    await staffNames(dpaId, b);
    const after = await membership();
    expect([after?.role, after?.deleted_at]).toEqual(["billing", null]);
    const accepted = await w.db
      .select()
      .from(schema.org_invite)
      .where(and(eq(schema.org_invite.org_id, w.orgId), eq(schema.org_invite.email, signer)));
    expect(accepted.every((i) => i.deleted_at === null)).toBe(true);
  });

  test("A replaced by B and then named again: A gets a fresh invitation, a working link and can sign", async () => {
    const a = fresh("a");
    const b = fresh("b");
    const doc = await pushed({ customer_signer: person(a) });
    const first = (await pending(a))?.id;
    await customerNames(doc.id, b);
    expect(await pending(a)).toBeNull();
    await customerNames(doc.id, a);
    const again = await pending(a);
    expect(again?.id).toBeDefined();
    expect(again?.id).not.toBe(first as string);
    await standing(a, doc.id);
    expect(await pending(b)).toBeNull();

    // The same for someone with an account, who then signs with the new naming.
    const signer = await signedIn(fresh("again"));
    const other = await pushed({ customer_signer: person(signer) });
    await customerNames(other.id, fresh("b"));
    expect(await pending(signer)).toBeNull();
    await customerNames(other.id, signer);
    expect((await pending(signer))?.role).toBe("billing");
    expect((await sign(other.id, "late" as keyof World["people"], "Late Signer")).status).toBe(
      200,
    );
  });
});
