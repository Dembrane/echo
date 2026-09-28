import type { Db } from "@dembrane/db";
import { localeOfEmail, localesOfAppUsers } from "@dembrane/i18n";

/**
 * The language an invite email speaks: the recipient's own when they have an account,
 * else the inviter's, else none (English).
 */
export async function recipientLocale(db: Db, email: string, inviterAppUserId: string) {
  try {
    return (
      (await localeOfEmail(db, email)) ??
      (await localesOfAppUsers(db, [inviterAppUserId])).get(inviterAppUserId) ??
      null
    );
  } catch {
    return null;
  }
}
