import type { OfferContent } from "./offer";
import type { FieldRow, SignatureRow } from "./storage";

/**
 * Whose signature a document asks for. Every document has the customer's; an offer may ask
 * for a second: another signatory of the customer, or dembrane's counter-signature. Each
 * signature is its own insert-only row (one per slot), its fields are the ones with its
 * role, and the document is signed, with everything signing sets in motion, once every
 * slot is filled. A document that asks for one signature behaves as it always did.
 */
export type Slot = "customer" | "second" | "dembrane";

/** The fields' signer role of each slot. */
export const ROLE_OF: Record<Slot, "signer" | "second" | "dembrane"> = {
  customer: "signer",
  second: "second",
  dembrane: "dembrane",
};

/** The slots a document asks for, in the order the customer meets them. */
export function slotsOf(content: OfferContent | null): Slot[] {
  const second = content?.second_signer?.kind;
  return second === "customer"
    ? ["customer", "second"]
    : second === "dembrane"
      ? ["customer", "dembrane"]
      : ["customer"];
}

/**
 * The slots still to sign, given the signatures made so far. An acceptance recorded outside
 * dembrane (their order letter, their paper copy) stands for the customer's side whole: a
 * second signatory of theirs is not asked for again.
 */
export function awaitingSlots(
  content: OfferContent | null,
  signatures: readonly Pick<SignatureRow, "slot" | "outsideVia">[],
): Slot[] {
  const done = new Set(signatures.map((s) => s.slot));
  if (signatures.some((s) => s.outsideVia)) done.add("second");
  return slotsOf(content).filter((s) => !done.has(s));
}

/** The fields one slot fills in. */
export const fieldsOf = <F extends Pick<FieldRow, "signerRole">>(
  fields: readonly F[],
  slot: Slot,
) => fields.filter((f) => (f.signerRole ?? "signer") === ROLE_OF[slot]);

/**
 * The customer-side slot a person signs next: the first signature, or the second
 * signatory's once the first is in. Null when no customer signature is left.
 */
export function customerSlot(awaiting: readonly Slot[]): "customer" | "second" | null {
  if (awaiting.includes("customer")) return "customer";
  if (awaiting.includes("second")) return "second";
  return null;
}
