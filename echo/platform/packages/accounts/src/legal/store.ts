import { newId } from "@dembrane/core";
import type { Logger } from "@dembrane/observability";
import type { Conn } from "../deps";
import { type LegalRow, store } from "../storage";
import {
  LEGAL_KINDS,
  LEGAL_URLS,
  type LegalKind,
  type ParsedLegal,
  parseLegalDump,
  parseLegalPage,
} from "./parse";
import { REFERENCE_DPA, REFERENCE_SLA, REFERENCE_TERMS } from "./reference";

const REFERENCE: Record<LegalKind, string> = {
  terms: REFERENCE_TERMS,
  sla: REFERENCE_SLA,
  dpa: REFERENCE_DPA,
};

/** A push refreshes the texts first when the last check is older than this. */
export const STALE_AFTER_MS = 60 * 60 * 1000;

export interface LegalDeps {
  readonly db: Conn;
  readonly fetchText: (url: string) => Promise<string>;
  readonly logger: Logger;
  readonly now: () => Date;
}

export type RefreshOutcome =
  | { kind: LegalKind; outcome: "unchanged"; version: string }
  | { kind: LegalKind; outcome: "inserted"; version: string }
  | { kind: LegalKind; outcome: "failed"; error: string };

async function insertParsed(c: Conn, kind: LegalKind, p: ParsedLegal, url: string, at: Date) {
  return store.insertLegal(c, {
    id: newId(),
    kind,
    version: p.version,
    effectiveOn: p.effectiveOn,
    title: p.title,
    body: p.body,
    sha256: p.sha256,
    sourceUrl: url,
    createdAt: at,
  });
}

/**
 * The first rows, from the captures in packages/accounts/reference, for any kind with none yet.
 * Runs with every migration job, so an environment that cannot reach dembrane.com still
 * has texts to pin. Never adds a second row once a kind has one.
 */
export async function seedLegalTexts(c: Conn, now: Date): Promise<number> {
  let added = 0;
  for (const kind of LEGAL_KINDS) {
    if (await store.latestLegal(c, kind)) continue;
    if (await insertParsed(c, kind, parseLegalDump(REFERENCE[kind]), LEGAL_URLS[kind], now))
      added++;
  }
  return added;
}

/**
 * Fetches each legal page and stores a new row only when its text changed (a different
 * sha256 from the newest stored row). A failed fetch or an unreadable page is recorded on
 * the source and logged; it never throws, so a push that refreshes first is never blocked.
 */
export async function refreshLegalTexts(d: LegalDeps): Promise<RefreshOutcome[]> {
  // The three pages are fetched at once, so a push waits for one timeout at most.
  return Promise.all(LEGAL_KINDS.map((kind) => refreshOne(d, kind)));
}

async function refreshOne(d: LegalDeps, kind: LegalKind): Promise<RefreshOutcome> {
  const url = LEGAL_URLS[kind];
  const at = d.now();
  try {
    const parsed = parseLegalPage(await d.fetchText(url));
    const latest = await store.latestLegal(d.db, kind);
    let outcome: RefreshOutcome;
    if (latest?.sha256 === parsed.sha256) {
      outcome = { kind, outcome: "unchanged", version: latest.version };
    } else {
      // A text reverting to an older wording conflicts on (kind, sha256) and inserts
      // nothing; the older row is then not the newest, which a person has to look at.
      const inserted = await insertParsed(d.db, kind, parsed, url, at);
      if (!inserted)
        d.logger.warn(
          { kind, version: parsed.version, signal: "accounts.legal_reverted" },
          "legal text matches an older stored version",
        );
      outcome = { kind, outcome: inserted ? "inserted" : "unchanged", version: parsed.version };
      if (inserted)
        d.logger.info({ kind, version: parsed.version }, "new legal text version stored");
    }
    await store.markLegalChecked(d.db, kind, url, at, null);
    return outcome;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    d.logger.warn(
      { kind, err: { message: error }, signal: "accounts.legal_fetch_failed" },
      "legal text refresh failed; offers keep the newest stored version",
    );
    await store.markLegalChecked(d.db, kind, url, at, error.slice(0, 500));
    return { kind, outcome: "failed", error };
  }
}

export interface PinnedLegal {
  readonly terms: LegalRow;
  readonly sla: LegalRow;
  readonly dpa: LegalRow;
}

/**
 * The texts an offer pushed now pins: the newest of each kind, after a refresh when the
 * last check is more than an hour old. The reference captures fill any kind still empty.
 */
export async function legalForPush(d: LegalDeps): Promise<PinnedLegal> {
  const sources = await store.legalSources(d.db);
  const now = d.now().getTime();
  const stale = LEGAL_KINDS.some((kind) => {
    const s = sources.find((x) => x.kind === kind);
    return !s?.checkedAt || now - s.checkedAt.getTime() > STALE_AFTER_MS;
  });
  if (stale) await refreshLegalTexts(d);
  await seedLegalTexts(d.db, d.now());
  const [terms, sla, dpa] = await Promise.all(LEGAL_KINDS.map((k) => store.latestLegal(d.db, k)));
  if (!terms || !sla || !dpa) throw new Error("legal texts missing after seeding");
  return { terms, sla, dpa };
}
