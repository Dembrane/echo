import { createSign } from "node:crypto";

/**
 * Reading dembrane's own mailboxes for the account card's email section. A Google
 * Workspace service account with domain-wide delegation impersonates each listed mailbox
 * with the one scope gmail.readonly: it can search and read, never send, label or delete.
 * Nothing read here is stored; the account card asks again (account-email.ts).
 */

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users";

/** The parts of a Gmail message the email section reads (users.threads.get, format full). */
export interface GmailPart {
  readonly mimeType?: string;
  readonly headers?: readonly { name: string; value: string }[];
  readonly body?: { data?: string; size?: number };
  readonly parts?: readonly GmailPart[];
}
export interface GmailMessage {
  readonly id: string;
  readonly threadId: string;
  readonly internalDate?: string;
  readonly labelIds?: readonly string[];
  readonly payload?: GmailPart;
}
export interface GmailThread {
  readonly id: string;
  readonly messages?: readonly GmailMessage[];
}

/** What the email section needs from Gmail; a fake in tests. */
export interface GmailReader {
  /** The mailboxes searched, in order (dembrane addresses). */
  readonly mailboxes: readonly string[];
  /** Thread ids in one mailbox matching a Gmail search, newest first. */
  searchThreads(mailbox: string, q: string, max: number): Promise<string[]>;
  thread(mailbox: string, id: string): Promise<GmailThread>;
}

export interface ServiceAccountKey {
  readonly client_email: string;
  readonly private_key: string;
}

const b64url = (v: string | Buffer) =>
  Buffer.from(v).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** The signed JWT the token endpoint swaps for an access token acting as `mailbox`. */
export function delegationAssertion(key: ServiceAccountKey, mailbox: string, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: key.client_email,
      sub: mailbox,
      scope: GMAIL_SCOPE,
      aud: TOKEN_URL,
      iat,
      exp: iat + 3600,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${claims}`);
  return `${head}.${claims}.${b64url(signer.sign(key.private_key))}`;
}

/** Reads the service account key from its JSON (the file Google hands out). */
export function parseServiceAccount(json: string): ServiceAccountKey {
  const v = JSON.parse(json) as Partial<ServiceAccountKey>;
  if (typeof v.client_email !== "string" || typeof v.private_key !== "string")
    throw new Error("ACCOUNTS_GMAIL_SERVICE_ACCOUNT: client_email and private_key are required");
  return { client_email: v.client_email, private_key: v.private_key };
}

export function serviceAccountGmail(opts: {
  key: ServiceAccountKey;
  mailboxes: readonly string[];
  fetch?: typeof fetch;
  now?: () => Date;
}): GmailReader {
  const f = opts.fetch ?? fetch;
  const now = opts.now ?? (() => new Date());
  const tokens = new Map<string, { token: string; until: number }>();

  async function token(mailbox: string): Promise<string> {
    const hit = tokens.get(mailbox);
    if (hit && hit.until > now().getTime()) return hit.token;
    const res = await f(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: delegationAssertion(opts.key, mailbox, now()),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`gmail token for ${mailbox}: ${res.status} ${await res.text()}`);
    const v = (await res.json()) as { access_token: string; expires_in?: number };
    // A minute's margin so a token never expires between this check and the call.
    tokens.set(mailbox, {
      token: v.access_token,
      until: now().getTime() + ((v.expires_in ?? 3600) - 60) * 1000,
    });
    return v.access_token;
  }

  async function get<T>(mailbox: string, path: string): Promise<T> {
    const res = await f(`${API}/${encodeURIComponent(mailbox)}${path}`, {
      headers: { authorization: `Bearer ${await token(mailbox)}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`gmail ${mailbox}: ${res.status}`);
    return (await res.json()) as T;
  }

  return {
    mailboxes: opts.mailboxes,
    async searchThreads(mailbox, q, max) {
      const v = await get<{ threads?: { id: string }[] }>(
        mailbox,
        `/threads?${new URLSearchParams({ q, maxResults: String(max) })}`,
      );
      return (v.threads ?? []).map((t) => t.id);
    },
    thread: (mailbox, id) =>
      get<GmailThread>(mailbox, `/threads/${encodeURIComponent(id)}?format=full`),
  };
}

/** The reader the API runs with, or null while either setting is missing. */
export function gmailFromConfig(
  serviceAccount: string | undefined,
  mailboxes: string | undefined,
): GmailReader | null {
  const list = (mailboxes ?? "")
    .split(",")
    .map((m) => m.trim().toLowerCase())
    .filter(Boolean);
  if (!serviceAccount || !list.length) return null;
  return serviceAccountGmail({ key: parseServiceAccount(serviceAccount), mailboxes: list });
}
