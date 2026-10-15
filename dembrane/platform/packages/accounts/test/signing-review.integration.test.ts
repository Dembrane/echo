import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { emailHandler } from "@dembrane/account";
import { MemoryMailer } from "@dembrane/mail";
import { PDFDocument } from "pdf-lib";
import * as K from "../src/contract";
import { accountsRoutes } from "../src/routes";
import { MAX_ATTACHED_BYTES } from "../src/signed-copy";
import { isoOfDocumentDate } from "../src/signing";
import { store } from "../src/storage";
import { admin, call, dropDatabase, png, pngB64, silent, type World, world } from "./helpers";

// What a signature leaves behind for the people involved: the date it states, the language
// it was made in, the emailed copy, and the legal texts a signer can read before signing.
//   TEST_DATABASE_ADMIN_URL=postgres://dembrane:dembrane@localhost:5440/postgres
const run = admin ? describe : describe.skip;
const DB = `accounts_review_${process.pid}`;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

run("signing follows the review", () => {
  setDefaultTimeout(60_000);
  let w: World;
  const C = () => `/api/v2/orgs/${w.orgId}/account`;
  const S = () => `/api/v2/admin/accounts/${w.orgId}`;

  const offer = async (language: "nl" | "en") =>
    K.PushOfferResponse.parse(
      (
        await call(w, "POST", `${S()}/offers`, "staff", {
          template: "subscription",
          language,
          offer_name: "Gemeente Testdorp",
          person_name: "Anna",
          items: [
            {
              description: "dembrane changemaker, jaarlicentie",
              quantity: 60,
              unit_price_cents: 8600,
              vat_rate_bps: 2100,
            },
          ],
        })
      ).data,
    ).document.id;

  /** A sign request with every field filled; `date` replaces the date field's value. */
  async function signPayload(docId: string, as: keyof World["people"], date = "28-09-2026") {
    const detail = K.DocumentDetail.parse(
      (await call(w, "GET", `${C()}/documents/${docId}`, as)).data,
    );
    const values: Record<string, string | boolean> = {};
    for (const f of detail.fields) {
      if (f.kind === "name") values[f.id] = "Anna de Vries";
      else if (f.kind === "role") values[f.id] = "Wethouder";
      else if (f.kind === "date") values[f.id] = date;
      else if (f.kind === "text")
        values[f.id] = f.key === "organisation" ? "Gemeente Testdorp" : "Dorpsstraat 1, Testdorp";
    }
    const confirmation_text = (detail.confirmation?.dpa_authorised ?? "")
      .replace("{name}", "Anna de Vries")
      .replace("{role}", "Wethouder")
      .replace("{organisation}", "Gemeente Testdorp");
    return {
      detail,
      body: {
        sha256: detail.sha256,
        values,
        signature: { png_base64: pngB64(), method: "drawn" },
        initials: null,
        dpa_authorised: true,
        confirmation_text,
      },
    };
  }

  beforeAll(async () => {
    w = await world(DB, accountsRoutes);
  });
  afterAll(async () => {
    await w?.close();
    await dropDatabase(DB);
  });

  test("a signing date is a real day between the send and today", async () => {
    expect(isoOfDocumentDate("28-09-2026")).toBe("2026-09-28");
    expect(isoOfDocumentDate("2026-09-28")).toBe("2026-09-28");
    expect(isoOfDocumentDate("29-02-2028")).toBe("2028-02-29");
    for (const bad of [
      "asdf",
      "31-02-2026",
      "2026-02-31",
      "28/09/2026",
      "00-09-2026",
      "",
      "0000-01-01",
    ])
      expect(isoOfDocumentDate(bad)).toBeNull();

    const id = await offer("nl");
    const url = `${C()}/documents/${id}/sign`;
    // The clock reads 28 September 2026, 09:00 UTC, and the offer was sent just now.
    for (const bad of ["asdf", "31-02-2026", "2026-09-29", "29-09-2026", "25-09-2026"]) {
      const { body } = await signPayload(id, "admin", bad);
      const r = await call(w, "POST", url, "admin", body);
      expect([bad, r.status]).toEqual([bad, 422]);
    }
    expect(await store.signatureOf(w.db, id)).toBeNull();
    // A signer's calendar day may run a few hours either side of UTC.
    // An API client may send the ISO form; the signature keeps the printed form.
    const { body } = await signPayload(id, "admin", "2026-09-28");
    expect((await call(w, "POST", url, "admin", body)).status).toBe(200);
    const kept = (await store.signatureOf(w.db, id))?.fieldValues as Record<string, string>;
    expect(Object.values(kept)).toContain("28-09-2026");
    expect(Object.values(kept)).not.toContain("2026-09-28");
  });

  test("the signature keeps the language of the document and the emails follow it", async () => {
    w.jobs.jobs.length = 0;
    const id = await offer("en");
    const { body } = await signPayload(id, "billing");
    expect((await call(w, "POST", `${C()}/documents/${id}/sign`, "billing", body)).status).toBe(
      200,
    );
    const sig = await store.signatureOf(w.db, id);
    expect(sig?.language).toBe("en");
    expect(sig?.signedPdfKey).toBeTruthy();

    // The signer and the account's admin, each once; billing members who did not sign get none.
    const mails = w.jobs.of("account.send-email");
    expect(mails.map((m) => m.to).sort()).toEqual(["admin@example.test", "billing@example.test"]);
    const first = mails[0] as {
      language: string;
      template: string;
      data: Record<string, string>;
      attachments: { key: string; filename: string; content_type: string }[];
    };
    expect(first).toMatchObject({ language: "en", template: "account_signed_copy" });
    expect(first.attachments).toEqual([
      {
        key: sig?.signedPdfKey as string,
        filename: expect.stringContaining("(signed).pdf"),
        content_type: "application/pdf",
      },
    ]);
    expect(first.data).toMatchObject({
      signer_name: "Anna de Vries",
      signer_email: "billing@example.test",
      signed_at: "2026-09-28T09:00:00.000Z",
      document_id: id,
      sha256: sig?.signedPdfSha256,
      attached: "yes",
    });
    expect(first.data.document_url).toBe(
      `https://dash.test/o/${w.orgId}/account/documents/${id}/sign`,
    );

    // The timeline names who was written to.
    const events = await store.events(w.db, w.orgId);
    const signed = events.find((e) => e.type === "document.signed" && e.subjectId === id);
    expect(
      ((signed?.detail ?? { copy_sent_to: [] }) as { copy_sent_to: string[] }).copy_sent_to.sort(),
    ).toEqual(["admin@example.test", "billing@example.test"]);

    // What the worker sends: the signed PDF itself, whose fingerprint is the one in the mail.
    const mailer = new MemoryMailer();
    const handle = emailHandler(mailer, silent, async (key) => {
      const blob = await w.files.get(key);
      return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
    });
    await handle(first as never);
    const sent = mailer.sent[0];
    expect(sent?.subject).toBe(`${first.data.document_title} is signed`);
    expect(sent?.text).toContain(`SHA-256 of the signed PDF: ${sig?.signedPdfSha256}`);
    expect(sent?.text).toContain("The signed PDF is attached.");
    expect(sent?.attachments).toHaveLength(1);
    const attachment = sent?.attachments?.[0];
    expect(sha(attachment?.content as Uint8Array)).toBe(sig?.signedPdfSha256 as string);
    expect(
      (await PDFDocument.load(attachment?.content as Uint8Array)).getPageCount(),
    ).toBeGreaterThan(1);
  });

  test("a Dutch document is signed and mailed in Dutch, and the same person gets one email", async () => {
    w.jobs.jobs.length = 0;
    const id = await offer("nl");
    const { body } = await signPayload(id, "admin");
    expect((await call(w, "POST", `${C()}/documents/${id}/sign`, "admin", body)).status).toBe(200);
    expect((await store.signatureOf(w.db, id))?.language).toBe("nl");
    const mails = w.jobs.of("account.send-email");
    // The signer is also the account's admin: one email.
    expect(mails.map((m) => m.to)).toEqual(["admin@example.test"]);
    expect(mails[0]).toMatchObject({ language: "nl" });
    const mailer = new MemoryMailer();
    await emailHandler(mailer, silent, async (key) => {
      const blob = await w.files.get(key);
      return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
    })(mails[0] as never);
    expect(mailer.sent[0]?.subject).toEndWith("is ondertekend");
    expect(mailer.sent[0]?.text).toContain("De ondertekende pdf zit als bijlage");
  });

  test("a copy too large to attach is linked, and a missing file is retried, not sent without it", async () => {
    const id = await offer("en");
    const doc = await store.document(w.db, w.orgId, id);
    const org = await store.org(w.db, w.orgId);
    const { emailSignedCopy } = await import("../src/signed-copy");
    w.jobs.jobs.length = 0;
    await emailSignedCopy(w.deps, w.db, org as never, doc as never, {
      signerName: "Anna",
      signerEmail: "signer@example.test",
      signedAt: "2026-09-28T09:00:00.000Z",
      pdfKey: "accounts/none.pdf",
      pdfSha256: "a".repeat(64),
      pdfBytes: MAX_ATTACHED_BYTES + 1,
    });
    const [mail] = w.jobs.of("account.send-email");
    expect(mail).not.toHaveProperty("attachments");
    expect((mail as { data: Record<string, string> }).data.attached).toBe("no");
    const mailer = new MemoryMailer();
    await emailHandler(mailer, silent)(mail as never);
    expect(mailer.sent[0]?.attachments).toBeUndefined();
    expect(mailer.sent[0]?.text).toContain("too large to attach");
    expect(mailer.sent[0]?.text).toContain(`/documents/${id}/sign`);

    const withFile = {
      ...(mail as object),
      attachments: [
        { key: "accounts/none.pdf", filename: "x.pdf", content_type: "application/pdf" },
      ],
    };
    await expect(emailHandler(mailer, silent, async () => null)(withFile as never)).rejects.toThrow(
      "not available",
    );
    expect(mailer.sent).toHaveLength(1);
  });

  test("the legal texts open at the version the document pinned, for the people who may read it", async () => {
    const id = await offer("en");
    const detail = K.DocumentDetail.parse(
      (await call(w, "GET", `${C()}/documents/${id}`, "admin")).data,
    );
    expect(detail.legal.map((l) => l.kind)).toEqual(["terms", "sla", "dpa"]);
    for (const pin of detail.legal)
      expect(pin.text_url).toBe(`${C()}/documents/${id}/legal/${pin.kind}`);
    const dpaPin = detail.legal.find((l) => l.kind === "dpa");

    // A newer version is published after the offer went out.
    const latest = await store.latestLegal(w.db, "dpa");
    expect(
      await store.insertLegal(w.db, {
        id: crypto.randomUUID(),
        kind: "dpa",
        version: "9.9.9",
        effectiveOn: "2026-10-01",
        title: latest?.title as string,
        body: "A newer text that this document did not pin.",
        sha256: "f".repeat(64),
        sourceUrl: latest?.sourceUrl as string,
        createdAt: w.clock.now,
      }),
    ).toBe(true);

    const res = await w.app.request(dpaPin?.text_url as string, { headers: { "x-as": "admin" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain(`Version ${dpaPin?.version}`);
    expect(html).toContain(dpaPin?.sha256 as string);
    expect(html).not.toContain("9.9.9");
    expect(html).not.toContain("A newer text");

    // The named signer reads them too; an outsider and a signed-out visitor do not.
    await call(w, "POST", `${C()}/documents/${id}/signer`, "admin", {
      name: "Signer Person",
      email: "signer@example.test",
      role: "Burgemeester",
    });
    const get = (as: string | null) =>
      w.app.request(`${C()}/documents/${id}/legal/terms`, {
        headers: as ? { "x-as": as } : {},
      });
    expect((await get("signer")).status).toBe(200);
    expect((await get("outsider")).status).toBe(404);
    expect((await get(null)).status).toBe(401);
    expect(
      (
        await w.app.request(`${C()}/documents/${id}/legal/constructor`, {
          headers: { "x-as": "admin" },
        })
      ).status,
    ).toBe(404);
    expect(png().byteLength).toBeGreaterThan(0);
  });
});
