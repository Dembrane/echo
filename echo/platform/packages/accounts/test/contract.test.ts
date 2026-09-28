import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import * as C from "../src/contract";
import * as F from "../src/fixtures";

// The UI is built against these fixtures; each must parse against the schema the route
// returns, so a contract change that breaks them fails here first.
const cases: [string, z.ZodType, unknown][] = [
  ["accountPage", C.AccountPage, F.accountPage],
  ["offerDetail", C.DocumentDetail, F.offerDetail],
  ["signedDpaDetail", C.DocumentDetail, F.signedDpaDetail],
  ["signTask", C.Task, F.signTask],
  ["billingTask", C.Task, F.billingTask],
  ["ticket", C.Ticket, F.ticket],
  ["signRequest", C.SignRequest, F.signRequest],
  ["signResponse", C.SignResponse, F.signResponse],
  ["signingRequests", C.SigningRequests, F.signingRequests],
  ["accountList", C.AccountList, F.accountList],
  ["accountCard", C.AccountCard, F.accountCard],
  ["pushOfferRequest", C.PushOfferRequest, F.pushOfferRequest],
  ["pushOfferResponse", C.PushOfferResponse, F.pushOfferResponse],
  ["createAccountResponse", C.CreateAccountResponse, F.createAccountResponse],
  ["offerFieldsResponse", C.DocumentFields, F.offerFieldsResponse],
];

describe("contract fixtures", () => {
  for (const [name, schema, value] of cases)
    test(`${name} parses`, () => {
      const r = schema.safeParse(value);
      if (!r.success) throw new Error(`${name}: ${JSON.stringify(r.error.issues, null, 2)}`);
      expect(r.success).toBe(true);
    });

  test("the demo scenario is all there", () => {
    const page = F.accountPage;
    expect(page.organisation.name).toBe("Gemeente Voorbeeldstad");
    expect(page.tasks.find((t) => t.kind === "sign")?.status).toBe("open");
    expect(page.tasks.find((t) => t.kind === "billing_details")?.locked).toBe(true);
    const offer = page.documents.find((d) => d.kind === "offer");
    expect(offer?.status).toBe("sent");
    expect(F.offerDetail.legal.map((l) => l.version)).toEqual(["2.0", "1.1", "3.0.1"]);
    expect(F.offerDetail.fields.some((f) => f.kind === "signature")).toBe(true);
    expect(page.documents.find((d) => d.status === "signed")?.signed_pdf_url).toBeTruthy();
    const invoice = page.documents.find((d) => d.kind === "invoice");
    expect(invoice?.invoice?.bank_transfer.iban).toBeTruthy();
    expect(page.tickets[0]?.messages.map((m) => m.from)).toEqual(["customer", "dembrane"]);
  });

  test("offer totals in the fixtures add up in integer cents", () => {
    const lines = F.offerDetail.lines ?? [];
    expect(lines.reduce((s, l) => s + l.net_cents, 0)).toBe(F.offerDetail.subtotal_cents as number);
    expect(lines.reduce((s, l) => s + l.vat_cents, 0)).toBe(F.offerDetail.vat_cents as number);
    expect((F.offerDetail.subtotal_cents as number) + (F.offerDetail.vat_cents as number)).toBe(
      F.offerDetail.total_cents as number,
    );
  });

  test("every route names a permission and zod schemas", () => {
    for (const [name, r] of Object.entries(C.ROUTES)) {
      expect(r.path.startsWith("/api/v2/")).toBe(true);
      expect(r.permission).toBeTruthy();
      for (const k of ["request", "response", "query"] as const) {
        const s = (r as Record<string, unknown>)[k];
        if (s !== undefined)
          expect(typeof (s as z.ZodType).safeParse, `${name}.${k}`).toBe("function");
      }
    }
  });
});
