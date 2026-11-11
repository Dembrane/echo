import type { Locale } from "@dembrane/i18n";
import type { Conn } from "./deps";
import { store } from "./storage";
import { languageOf } from "./task-text";

export interface AccountRecipient {
  readonly appUserId: string;
  readonly email: string;
  readonly language: Locale;
}

/**
 * Who an email about an account goes to: the people who run it (owners, admins, billing)
 * that have an address, each address once. Each is written to in their own language (their
 * dashboard setting), else in the organisation's (the language of its newest document),
 * else in English. Every email the server sends about an account takes its recipients
 * from here, so they all reach the same people in the same language.
 */
export async function accountRecipients(
  c: Conn,
  orgId: string,
  /** Only members with one of these roles; all who run the account when absent. */
  roles?: readonly string[],
): Promise<AccountRecipient[]> {
  const people = (await store.accountPeople(c, orgId)).filter(
    (p) => p.email && (!roles || roles.includes(p.role)),
  );
  if (!people.length) return [];
  const [newest] = await store.documents(c, orgId);
  const orgLanguage = languageOf(newest?.language);
  const byAddress = new Map<string, AccountRecipient>();
  for (const p of people) {
    const email = p.email as string;
    const address = email.trim().toLowerCase();
    if (byAddress.has(address)) continue;
    byAddress.set(address, {
      appUserId: p.appUserId,
      email,
      language: p.language ? languageOf(p.language) : orgLanguage,
    });
  }
  return [...byAddress.values()];
}
