import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Which translations a machine wrote and nobody has reviewed yet, per catalog directory:
 * `machine-translations.json` beside the .po files, `{ locale: { key: text } }` where key
 * is the msgid (with its context before a \u0004 when it has one) and text is what the
 * model wrote. An entry is reviewed once a person changes its text in the .po (the ledger
 * no longer matches) or deletes it from the ledger to approve it as is. The filler only
 * ever fills empty entries, so a reviewed translation is never replaced.
 */
export type Ledger = Record<string, Record<string, string>>;

export const LEDGER_FILE = "machine-translations.json";

export function readLedger(dir: string): Ledger {
  const file = path.join(dir, LEDGER_FILE);
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf8")) as Ledger;
}

export function writeLedger(dir: string, ledger: Ledger): void {
  const sorted: Ledger = {};
  for (const locale of Object.keys(ledger).sort()) {
    const entries = ledger[locale] ?? {};
    const keys = Object.keys(entries).sort();
    if (!keys.length) continue;
    sorted[locale] = Object.fromEntries(keys.map((k) => [k, entries[k] as string]));
  }
  writeFileSync(path.join(dir, LEDGER_FILE), `${JSON.stringify(sorted, null, 2)}\n`);
}

/**
 * Drops ledger entries a person has since dealt with: the text in the catalog changed, or
 * the entry is gone. What is left is what still waits for review.
 */
export function pruneLedger(
  ledger: Ledger,
  locale: string,
  current: ReadonlyMap<string, string>,
): number {
  const entries = ledger[locale] ?? {};
  for (const [key, text] of Object.entries(entries))
    if (current.get(key) !== text) delete entries[key];
  ledger[locale] = entries;
  return Object.keys(entries).length;
}
