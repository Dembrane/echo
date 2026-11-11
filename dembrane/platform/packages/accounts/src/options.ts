import { ValidationError } from "@dembrane/core";
import { type OfferLine, type PricedLine, priceLines, type Totals } from "./money";

/**
 * Options the customer picks when signing: optional lines that carry an option's name
 * ("Scenario A"). Lines with one name are one option, chosen together. An offer picks
 * exactly one (`one`: two scenarios, each its own total) or any (`any`: add-ons). What was
 * offered is what the PDF shows and its hash binds; the choice is the ticks the signer
 * leaves on its option fields, recorded with the signature. Chosen lines are charged from
 * then on, so the signed document's totals and its invoice request carry the choice.
 */
export const CHOOSE_MODES = ["any", "one"] as const;
export type ChooseMode = (typeof CHOOSE_MODES)[number];

export interface OptionLine extends OfferLine {
  readonly option?: string | undefined;
}

export interface OfferOption {
  /** From 1, in the order the options first appear. */
  readonly number: number;
  readonly label: string;
  /** The indexes of its lines in the offer. */
  readonly lines: readonly number[];
}

/** The key of an option's tick field on the PDF. */
export const optionKey = (n: number) => `option:${n}`;

/** The options of an offer's lines, in the order they first appear. */
export function optionsOf(items: readonly OptionLine[]): OfferOption[] {
  const out: { number: number; label: string; lines: number[] }[] = [];
  items.forEach((l, i) => {
    if (!l.option) return;
    const known = out.find((o) => o.label === l.option);
    if (known) known.lines.push(i);
    else out.push({ number: out.length + 1, label: l.option, lines: [i] });
  });
  return out;
}

/**
 * The lines as signed: a chosen option's lines charged (no kind, `chosen` true), the others
 * still optional (`chosen` false). Lines without an option stay as they are.
 */
export function withChoice<L extends OptionLine>(
  items: readonly L[],
  chosen: readonly string[],
): (L & { chosen?: boolean })[] {
  return items.map((l) => {
    if (!l.option) return l;
    if (!chosen.includes(l.option)) return { ...l, chosen: false };
    const { kind: _k, ...rest } = l;
    return { ...rest, chosen: true } as L & { chosen: boolean };
  });
}

/**
 * Checks the options of an offer being drafted. Only an optional line is an option; picking
 * exactly one needs two to pick from, and each pick must make an offer above zero (checked
 * with `require`, the offer's own amount rule). Options are not for an offer invoiced in
 * parts or of no charge. Gives back the mode as stored: null without options.
 */
export function checkOptions(
  items: readonly OptionLine[],
  choose: ChooseMode | null | undefined,
  rules: { noCharge: boolean; plan: boolean; require: (lines: readonly OfferLine[]) => Totals },
): ChooseMode | null {
  items.forEach((l, i) => {
    if (l.option && l.kind !== "optional")
      throw new ValidationError("offer.option_not_optional", { params: { line: i + 1 } });
  });
  const options = optionsOf(items);
  if (!options.length) {
    rules.require(items);
    return null;
  }
  if (rules.noCharge || rules.plan) throw new ValidationError("offer.options_not_here");
  const mode = choose ?? "any";
  if (mode === "any") {
    rules.require(items);
    return mode;
  }
  if (options.length < 2) throw new ValidationError("offer.choose_one_needs_two");
  for (const o of options) rules.require(withChoice(items, [o.label]));
  return mode;
}

/**
 * What the signer chose: the options whose tick field they ticked. With `one` exactly one.
 * `fields` are the document's, by key; `values` the signer's, by field id.
 */
export function chosenOptions(
  items: readonly OptionLine[],
  mode: ChooseMode | undefined,
  fields: readonly { readonly id: string; readonly key: string | null }[],
  values: Readonly<Record<string, string | boolean>>,
): string[] {
  const options = optionsOf(items);
  if (!options.length) return [];
  const chosen = options
    .filter((o) => {
      const f = fields.find((x) => x.key === optionKey(o.number));
      return f ? values[f.id] === true : false;
    })
    .map((o) => o.label);
  if ((mode ?? "any") === "one" && chosen.length !== 1)
    throw new ValidationError("document.choose_one");
  return chosen;
}

/** The document's priced lines and totals as signed with this choice. */
export function signedTotals(items: readonly OptionLine[], chosen: readonly string[]) {
  const totals = priceLines(withChoice(items, chosen));
  return {
    lines: totals.lines as (PricedLine & { chosen?: boolean })[],
    subtotalCents: totals.subtotal_cents,
    vatCents: totals.vat_cents,
    totalCents: totals.total_cents,
  };
}

/** An option's amounts: what its lines add before and after VAT, as if charged. */
export function optionAmounts(items: readonly OptionLine[], option: OfferOption) {
  const priced = priceLines(items).lines;
  const lines = option.lines.map((i) => priced[i] as PricedLine);
  return {
    net_cents: lines.reduce((s, l) => s + l.net_cents, 0),
    vat_cents: lines.reduce((s, l) => s + l.vat_cents, 0),
  };
}
