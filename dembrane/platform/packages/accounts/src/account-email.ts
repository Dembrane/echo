import { createHash } from "node:crypto";
import { UnavailableError } from "@dembrane/core";
import type { z } from "zod";
import { staffOrg } from "./access";
import type { AccountEmail, MailPerson, MailThread } from "./contract";
import type { AccountsDeps } from "./deps";
import { mailIdentity, memberAddresses } from "./email-domains";
import type { GmailMessage, GmailReader } from "./gmail";
import { addresses, header, messageText } from "./mail-text";

/**
 * The account card's email: every conversation between dembrane's mailboxes and one
 * organisation, read live from Gmail each time and stored nowhere (a few minutes of
 * memory at most). An organisation is matched by its members' own email domains and the
 * exact address of members at public providers, so only organisations that exist in echo
 * have email, and mail with anyone else never appears. Each thread is merged across
 * mailboxes (the same Message-ID is one message) and rendered as a chat: every message
 * keeps only the text it added.
 */

type Out = z.output<typeof AccountEmail>;
type Thread = z.output<typeof MailThread>;
type Person = z.output<typeof MailPerson>;

/** Threads read per mailbox, newest first; older conversations stay in Gmail. */
const PER_MAILBOX = 30;
/** How far back the search looks. */
const WINDOW = "newer_than:2y";
const CACHE_MS = 5 * 60_000;
const MAX_TERMS = 30;

const cache = new WeakMap<GmailReader, Map<string, { at: number; value: Out }>>();

/** The Gmail search for one organisation: any message from, to or cc'd to it. */
export function searchFor(identity: { domains: string[]; addresses: string[] }): string | null {
  const terms = [...identity.domains, ...identity.addresses].slice(0, MAX_TERMS);
  if (!terms.length) return null;
  const any = terms.flatMap((t) => [`from:${t}`, `to:${t}`, `cc:${t}`]).join(" ");
  return `{${any}} ${WINDOW} -in:chats`;
}

const subjectOf = (s: string | null) =>
  (s ?? "").replace(/^\s*((re|fw|fwd|aw|wg|antw|doorst|tr|rv)\s*(\[\d+\])?\s*:\s*)+/i, "").trim() ||
  "(no subject)";

export const gmailUrl = (mailbox: string, threadId: string) =>
  `https://mail.google.com/mail/u/${encodeURIComponent(mailbox)}/#all/${threadId}`;

interface Parsed {
  readonly key: string;
  readonly mailbox: string;
  readonly gmailThread: string;
  readonly from: { name: string | null; email: string };
  readonly to: string[];
  readonly cc: string[];
  readonly at: Date;
  readonly subject: string | null;
  readonly text: string;
}

function parse(mailbox: string, m: GmailMessage): Parsed | null {
  if (m.labelIds?.includes("DRAFT")) return null;
  const p = m.payload;
  const from = addresses(header(p, "from"))[0];
  if (!from) return null;
  const date = header(p, "date");
  const at = m.internalDate ? new Date(Number(m.internalDate)) : new Date(date ?? NaN);
  if (Number.isNaN(at.getTime())) return null;
  const mid = header(p, "message-id")?.trim();
  return {
    key: mid || `${mailbox}:${m.id}`,
    mailbox,
    gmailThread: m.threadId,
    from,
    to: addresses(header(p, "to")).map((a) => a.email),
    cc: addresses(header(p, "cc")).map((a) => a.email),
    at,
    subject: header(p, "subject"),
    text: messageText(p),
  };
}

/**
 * Merges the threads read from every mailbox: two Gmail threads that share a message are
 * one conversation. Keeps only conversations with someone of the organisation in them.
 */
export function mergeThreads(
  read: readonly { mailbox: string; messages: readonly GmailMessage[] }[],
  identity: { domains: readonly string[]; addresses: readonly string[] },
): Thread[] {
  const domains = new Set(identity.domains);
  const exact = new Set(identity.addresses);
  const sideOf = (email: string): Person["side"] => {
    if (email.endsWith("@dembrane.com")) return "dembrane";
    if (exact.has(email) || domains.has(email.split("@")[1] ?? "")) return "organisation";
    return "other";
  };

  // Union-find over (mailbox, gmail thread), joined by shared Message-IDs.
  const parent = new Map<string, string>();
  const root = (x: string): string => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const r = root(p);
    parent.set(x, r);
    return r;
  };
  const join = (a: string, b: string) => {
    const ra = root(a);
    const rb = root(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const byKey = new Map<string, Parsed[]>();
  const ownerOf = new Map<string, string>();
  for (const t of read)
    for (const m of t.messages) {
      const v = parse(t.mailbox, m);
      if (!v) continue;
      const node = `${v.mailbox}\u0000${v.gmailThread}`;
      parent.set(node, parent.get(node) ?? node);
      const seen = ownerOf.get(v.key);
      if (seen) join(node, seen);
      else ownerOf.set(v.key, node);
      byKey.set(v.key, [...(byKey.get(v.key) ?? []), v]);
    }

  const groups = new Map<string, Parsed[][]>();
  for (const copies of byKey.values()) {
    const first = copies[0] as Parsed;
    const g = root(`${first.mailbox}\u0000${first.gmailThread}`);
    groups.set(g, [...(groups.get(g) ?? []), copies]);
  }

  const threads: Thread[] = [];
  for (const group of groups.values()) {
    const messages = group
      .map((copies) => {
        const m = copies[0] as Parsed;
        return {
          id: m.key,
          from: { name: m.from.name, email: m.from.email, side: sideOf(m.from.email) },
          to: m.to,
          cc: m.cc,
          sent_at: m.at.toISOString(),
          text: m.text,
          mailboxes: [...new Set(copies.map((c) => c.mailbox))].sort(),
        };
      })
      .sort((a, b) => a.sent_at.localeCompare(b.sent_at));
    const people = new Map<string, Person>();
    for (const m of messages) {
      if (!people.has(m.from.email) || !people.get(m.from.email)?.name)
        people.set(m.from.email, m.from);
      for (const e of [...m.to, ...m.cc])
        if (!people.has(e)) people.set(e, { name: null, email: e, side: sideOf(e) });
    }
    const participants = [...people.values()];
    if (!participants.some((p) => p.side === "organisation")) continue;
    const links = new Map<string, string>();
    for (const copies of group)
      for (const c of copies) if (!links.has(c.mailbox)) links.set(c.mailbox, c.gmailThread);
    const firstMessage = messages[0];
    const firstParsed = group.flat().find((c) => c.key === firstMessage?.id);
    threads.push({
      id: createHash("sha1")
        .update(firstMessage?.id ?? "")
        .digest("hex")
        .slice(0, 16),
      subject: subjectOf(firstParsed?.subject ?? null),
      last_message_at: messages[messages.length - 1]?.sent_at ?? new Date(0).toISOString(),
      participants,
      gmail: [...links].sort().map(([mailbox, id]) => ({ mailbox, url: gmailUrl(mailbox, id) })),
      messages,
    });
  }
  return threads.sort((a, b) => b.last_message_at.localeCompare(a.last_message_at));
}

/** Runs `fn` over `items` at most `n` at a time. */
async function pool<T, R>(items: readonly T[], n: number, fn: (t: T) => Promise<R>) {
  const out: R[] = [];
  let i = 0;
  const work = async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, work));
  return out;
}

export async function accountEmail(
  d: AccountsDeps,
  orgId: string,
  opts: { refresh?: boolean } = {},
): Promise<Out> {
  const gmail = d.gmail;
  if (!gmail) throw new UnavailableError("account_email.not_configured");
  const org = await staffOrg(d, orgId);
  const now = d.now();
  const mine = cache.get(gmail) ?? new Map<string, { at: number; value: Out }>();
  cache.set(gmail, mine);
  const hit = mine.get(org.id);
  if (!opts.refresh && hit && now.getTime() - hit.at < CACHE_MS) return hit.value;

  const identity = mailIdentity(await memberAddresses(d.db, org.id));
  const q = searchFor(identity);
  const status: { mailbox: string; ok: boolean }[] = [];
  const read: { mailbox: string; messages: GmailMessage[] }[] = [];
  if (q)
    for (const mailbox of gmail.mailboxes) {
      try {
        const ids = await gmail.searchThreads(mailbox, q, PER_MAILBOX);
        const threads = await pool(ids, 5, (id) => gmail.thread(mailbox, id));
        for (const t of threads) read.push({ mailbox, messages: [...(t.messages ?? [])] });
        status.push({ mailbox, ok: true });
      } catch (e) {
        d.logger.warn(
          { mailbox, error: e instanceof Error ? e.message : String(e) },
          "account email: a mailbox could not be read",
        );
        status.push({ mailbox, ok: false });
      }
    }
  else for (const mailbox of gmail.mailboxes) status.push({ mailbox, ok: true });

  const value: Out = {
    organisation: { id: org.id, name: org.name },
    matched: identity,
    mailboxes: status,
    threads: mergeThreads(read, identity),
    fetched_at: now.toISOString(),
  };
  // A partial read is not cached, so the next open tries the failed mailbox again.
  if (status.every((s) => s.ok)) mine.set(org.id, { at: now.getTime(), value });
  return value;
}
