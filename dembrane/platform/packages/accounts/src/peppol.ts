/**
 * Peppol: invoices go from Exact into the customer's accounting system as data, not as a
 * PDF in a mailbox. A customer that is in the Peppol directory gets its invoices that way
 * unless someone chose email (`invoice_delivery`). The directory is public; a participant
 * is found by an identifier we already ask for: KvK (scheme 0106), KBO (0208), or a Dutch
 * (9944) or Belgian (9925) VAT number.
 */

import type { AccountsDeps } from "./deps";

export const DIRECTORY = "https://directory.peppol.eu/search/1.0/json";

export interface PeppolMatch {
  readonly participant_id: string;
  readonly name: string | null;
}

export interface TaxIds {
  readonly vat_id?: string | null | undefined;
  readonly kvk_number?: string | null | undefined;
  readonly kbo_number?: string | null | undefined;
}

const digits = (v: string) => v.replace(/\D/g, "");

/** The participant ids to try, most specific first. */
export function candidates(ids: TaxIds): string[] {
  const out: string[] = [];
  const kvk = digits(ids.kvk_number ?? "");
  if (kvk.length === 8) out.push(`0106:${kvk}`);
  const kbo = digits(ids.kbo_number ?? "");
  if (kbo.length === 10) out.push(`0208:${kbo}`);
  const vat = (ids.vat_id ?? "").replace(/[\s.-]/g, "").toUpperCase();
  if (/^NL\d{9}B\d{2}$/.test(vat)) out.push(`9944:${vat}`);
  if (/^BE[01]\d{9}$/.test(vat)) {
    out.push(`9925:${vat}`);
    if (!out.some((c) => c.startsWith("0208:"))) out.push(`0208:${vat.slice(2)}`);
  }
  return out;
}

interface DirectoryAnswer {
  readonly matches?: ReadonlyArray<{
    readonly participantID?: { readonly value?: string };
    readonly entities?: ReadonlyArray<{
      readonly name?: ReadonlyArray<{ readonly name?: string }>;
    }>;
  }>;
}

/**
 * The first identifier the directory knows, or null. A directory that cannot be reached
 * counts as no match, so saving billing details never fails because of it.
 */
export async function lookupPeppol(
  d: Pick<AccountsDeps, "fetchText" | "logger">,
  ids: TaxIds,
): Promise<PeppolMatch | null> {
  for (const id of candidates(ids)) {
    const url = `${DIRECTORY}?participant=${encodeURIComponent(`iso6523-actorid-upis::${id}`)}`;
    try {
      const answer = JSON.parse(await d.fetchText(url)) as DirectoryAnswer;
      const hit = answer.matches?.[0];
      if (!hit) continue;
      const value = hit.participantID?.value ?? id;
      return {
        participant_id: value.includes(":") ? value : id,
        name: hit.entities?.[0]?.name?.[0]?.name?.trim() || null,
      };
    } catch (err) {
      d.logger.warn({ err, id }, "peppol directory lookup failed");
      return null;
    }
  }
  return null;
}
