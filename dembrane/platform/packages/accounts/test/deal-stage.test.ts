import { describe, expect, test } from "bun:test";
import { dealMilestones, dealStage, type StageDocument } from "../src/deal-stage";

// The deal stage is read from what the account holds; each case is one account's facts.
const at = (day: number) => new Date(Date.UTC(2026, 9, day));
const doc = (over: Partial<StageDocument>): StageDocument => ({
  kind: "offer",
  status: "sent",
  createdAt: at(1),
  sentAt: at(2),
  signedAt: null,
  dpaTextId: "dpa-1",
  invoiceStatus: null,
  ...over,
});
const signed = doc({ status: "signed", signedAt: at(5) });
const stage = (documents: StageDocument[], billingComplete = true, isAccount = true) =>
  dealStage({ isAccount, documents, billingComplete });

describe("the deal stage of an account", () => {
  test("no offer: in progress for an account, nothing for an organisation that is not one", () => {
    expect(stage([])).toBe("in_progress");
    expect(stage([], true, false)).toBeNull();
    // A withdrawn offer says nothing.
    expect(stage([doc({ status: "void" })])).toBe("in_progress");
  });

  test("the newest offer that stands decides: drafted, sent, lost", () => {
    expect(stage([doc({ status: "draft" })])).toBe("offer_drafted");
    expect(stage([doc({ status: "sent" })])).toBe("offer_sent");
    expect(stage([doc({ status: "viewed" })])).toBe("offer_sent");
    expect(stage([doc({ status: "declined" })])).toBe("lost");
    expect(stage([signed, doc({ status: "draft", createdAt: at(9) })])).toBe("offer_drafted");
  });

  test("a signed offer is accepted only with the billing details and every required document", () => {
    expect(stage([signed], false)).toBe("offer_sent");
    const dpa = (status: string) => doc({ kind: "dpa", status, createdAt: at(1) });
    expect(stage([signed, dpa("sent")])).toBe("offer_sent");
    expect(stage([signed, dpa("signed")])).toBe("offer_accepted");
    // No separate DPA went out, so none is waited for; another offer's DPA does not count.
    expect(stage([signed])).toBe("offer_accepted");
    expect(stage([signed, doc({ kind: "dpa", status: "sent", dpaTextId: "dpa-0" })])).toBe(
      "offer_accepted",
    );
  });

  test("an invoice after the signature: sent until every one is paid", () => {
    const invoice = (invoiceStatus: string, day = 8) =>
      doc({ kind: "invoice", status: "sent", invoiceStatus, createdAt: at(day) });
    expect(stage([signed, invoice("open")])).toBe("invoice_sent");
    expect(stage([signed, invoice("overdue")])).toBe("invoice_sent");
    expect(stage([signed, invoice("paid"), invoice("open", 9)])).toBe("invoice_sent");
    expect(stage([signed, invoice("paid")])).toBe("paid");
    // An older invoice belongs to an earlier deal; a void one to none.
    expect(stage([signed, invoice("paid", 2)])).toBe("offer_accepted");
    expect(stage([signed, invoice("void")])).toBe("offer_accepted");
  });

  test("a draft revision waits beside the offer it replaces; that offer still decides", () => {
    const sent = doc({ id: "offer-1" });
    const revision = doc({
      id: "offer-2",
      status: "draft",
      createdAt: at(3),
      sentAt: null,
      supersedesId: "offer-1",
    });
    expect(stage([sent, revision])).toBe("offer_sent");
    const m = dealMilestones({
      isAccount: true,
      documents: [sent, revision],
      billingComplete: false,
    });
    expect([m.offer_drafted, m.offer_sent]).toEqual([at(1).toISOString(), at(2).toISOString()]);
    // Once that offer is withdrawn, the revision is what stands.
    expect(stage([{ ...sent, status: "void" }, revision])).toBe("offer_drafted");
    // A draft that replaces nothing is the newest offer, as before.
    expect(stage([sent, { ...revision, supersedesId: null }])).toBe("offer_drafted");
  });

  test("the dates behind the stage: each step from when it happened, nothing before", () => {
    const day = (n: number) => at(n).toISOString();
    expect(dealMilestones({ isAccount: true, documents: [], billingComplete: false })).toEqual({
      offer_drafted: null,
      offer_sent: null,
      signed: null,
      billing_details: null,
      documents_signed: null,
      invoice_sent: null,
    });
    const draft = dealMilestones({
      isAccount: true,
      documents: [doc({ status: "draft", sentAt: null })],
      billingComplete: false,
    });
    expect([draft.offer_drafted, draft.offer_sent]).toEqual([day(1), null]);
    // Signed on the 5th, its DPA on the 6th, details saved on the 7th, invoiced on the 8th.
    const dpa = doc({ kind: "dpa", status: "signed", signedAt: at(6) });
    const invoice = doc({
      kind: "invoice",
      status: "sent",
      createdAt: at(8),
      invoiceStatus: "open",
    });
    expect(
      dealMilestones({
        isAccount: true,
        documents: [signed, dpa, invoice],
        billingComplete: true,
        billingAt: at(7),
      }),
    ).toEqual({
      offer_drafted: day(1),
      offer_sent: day(2),
      signed: day(5),
      billing_details: day(7),
      documents_signed: day(6),
      invoice_sent: day(8),
    });
    // A DPA still open leaves the documents step open; an offer without one is done when signed.
    const open = dealMilestones({
      isAccount: true,
      documents: [signed, doc({ kind: "dpa", status: "sent" })],
      billingComplete: false,
    });
    expect([open.signed, open.documents_signed, open.billing_details]).toEqual([
      day(5),
      null,
      null,
    ]);
    expect(
      dealMilestones({ isAccount: true, documents: [signed], billingComplete: false })
        .documents_signed,
    ).toBe(day(5));
  });
});
