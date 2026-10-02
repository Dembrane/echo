import { createHmac } from "node:crypto";
import { type Delivery, fetchChecked, type Resolve } from "./deliver";

/**
 * Messages to sam's inbox: one signed POST per event, `{"code","json"}` in the body.
 * sam verifies the signature against the exact bytes it receives, deduplicates on
 * (from, code, id), and refuses a changed body under an id it has seen. So the body is
 * serialised once, when the event happens, and every retry sends those same bytes under
 * the same id; only the timestamp and the signature over it are fresh per attempt.
 */

/** One event for sam. `code` names the payload and its version, e.g. support_request_v1. */
export interface SamMessage {
  readonly code: string;
  readonly json: Record<string, unknown>;
  /** Stable per event and unchanged across retries: sam's dedupe key. */
  readonly id: string;
}

/** A message as it is stored and sent: the body is the bytes that get signed. */
export interface SamEnvelope {
  readonly code: string;
  readonly id: string;
  readonly body: string;
}

/** Where messages go and who they are from; all three come from SAM_INBOX_*. */
export interface SamInboxTarget {
  readonly url: string;
  readonly secret: string;
  readonly from: string;
}

export interface SamInboxOptions {
  readonly allowPrivate: boolean;
  readonly resolve?: Resolve;
  /** Unix time source; tests pin it. */
  readonly now?: () => Date;
  /** Bounds one attempt; the queue's retry is the next attempt. */
  readonly timeoutMs?: number;
}

const CODE = /^[a-z][a-z0-9_]*_v[1-9][0-9]*$/;
const TIMEOUT_MS = 30_000;
/** sam refuses larger bodies with 413; refusing here keeps an oversized event out of the queue. */
export const SAM_INBOX_MAX_BODY = 256 * 1024;

export class SamInboxError extends Error {}

/** Serialises a message once. The result is what is signed and sent on every attempt. */
export function samEnvelope(m: SamMessage): SamEnvelope {
  if (!CODE.test(m.code)) throw new SamInboxError(`not a versioned code: ${m.code}`);
  if (!m.id || /[\r\n]/.test(m.id)) throw new SamInboxError("a message id is one line");
  const body = JSON.stringify({ code: m.code, json: m.json });
  if (Buffer.byteLength(body, "utf8") > SAM_INBOX_MAX_BODY)
    throw new SamInboxError(`message ${m.id} is over ${SAM_INBOX_MAX_BODY} bytes`);
  return { code: m.code, id: m.id, body };
}

/**
 * `sha256=<hex>` over "sam-inbox-v1\n" + from + "\n" + timestamp + "\n" + id + "\n" and
 * then the body's UTF-8 bytes. The prefix and the fields keep a signature from being
 * replayed under another sender, time or id.
 */
export function samInboxSignature(p: {
  secret: string;
  from: string;
  timestamp: string;
  id: string;
  body: string | Uint8Array;
}): string {
  return `sha256=${createHmac("sha256", p.secret)
    .update(`sam-inbox-v1\n${p.from}\n${p.timestamp}\n${p.id}\n`, "utf8")
    .update(typeof p.body === "string" ? Buffer.from(p.body, "utf8") : p.body)
    .digest("hex")}`;
}

/** What the queue does with an answer: done, try again later, or never again. */
export type SamOutcome = "delivered" | "retry" | "permanent";

/**
 * 2xx is done. 408, 429 and 5xx are sam busy or down and are retried. Anything else is a
 * refusal (bad signature, unknown code, conflicting body) that repeating cannot fix.
 */
export function samOutcome(status: number): SamOutcome {
  if (status >= 200 && status < 300) return "delivered";
  if (status === 408 || status === 429 || status >= 500) return "retry";
  return "permanent";
}

/**
 * One attempt: a fresh timestamp and signature over the stored body, sent through the
 * checked transport (pinned address, no redirects, a timeout). Network errors throw.
 */
export async function postSamEnvelope(
  target: SamInboxTarget,
  envelope: SamEnvelope,
  opts: SamInboxOptions,
): Promise<Delivery> {
  const timestamp = String(Math.floor((opts.now ?? (() => new Date()))().getTime() / 1000));
  const res = await fetchChecked(
    target.url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Dembrane-Webhook/1.0",
        "X-Webhook-From": target.from,
        "X-Webhook-Timestamp": timestamp,
        "X-Webhook-Id": envelope.id,
        "X-Webhook-Signature": samInboxSignature({
          secret: target.secret,
          from: target.from,
          timestamp,
          id: envelope.id,
          body: envelope.body,
        }),
      },
      body: envelope.body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
    },
    { allowPrivate: opts.allowPrivate, ...(opts.resolve && { resolve: opts.resolve }) },
  );
  return { status: res.status, text: (await res.text()).slice(0, 500) };
}

/** Serialises and sends one message now; callers that retry later keep the envelope instead. */
export function sendSamMessage(
  target: SamInboxTarget,
  message: SamMessage,
  opts: SamInboxOptions,
): Promise<Delivery> {
  return postSamEnvelope(target, samEnvelope(message), opts);
}

/**
 * A project webhook aimed at sam's inbox stores `sam-inbox:<code>` as its URL. The
 * customer routes accept only http and https URLs, so only the staff route can write one,
 * and the copy picker cannot carry it into another project.
 */
export const INBOX_SCHEME = "sam-inbox:";

/** The inbox code a webhook delivers under, or null for an ordinary URL webhook. */
export function inboxCodeOf(url: string | null): string | null {
  return url?.startsWith(INBOX_SCHEME) ? url.slice(INBOX_SCHEME.length) || null : null;
}
