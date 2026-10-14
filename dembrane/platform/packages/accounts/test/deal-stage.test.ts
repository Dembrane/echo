import { describe, expect, test } from "bun:test";
import { dealStage, type StageDocument } from "../src/deal-stage";

// The deal stage is read from what the account holds; each case is one account's facts.
const at = (day: number) => new Date(Date.UTC(2026, 9, day));
const doc = (over: Partial<StageDocument>): StageDocument => ({
  kind: "offer",
  status: "sent",
  createdAt: at(1),
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
});
