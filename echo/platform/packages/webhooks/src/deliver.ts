import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { pythonJson, signature } from "./signing";

/** One outbound POST: what the dispatcher and the test button need back. */
export interface Delivery {
  readonly status: number;
  readonly text: string;
}

export interface Target {
  readonly id: string;
  readonly name: string | null;
  readonly url: string | null;
  readonly secret: string | null;
}

/** Sends a webhook; a fake stands in for it in tests. */
export type Deliver = (target: Target, payload: Record<string, unknown>) => Promise<Delivery>;

export class DeliveryError extends Error {}

const TIMEOUT_MS = 40_000; // 10s to connect plus 30s to answer, as before

function v4Private(ip: string): boolean {
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

/** Loopback, private, link-local, carrier-grade NAT, multicast and reserved addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return v4Private(ip);
  const low = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(low);
  if (mapped?.[1]) return v4Private(mapped[1]);
  return (
    low === "::" ||
    low === "::1" ||
    low.startsWith("fc") ||
    low.startsWith("fd") ||
    low.startsWith("fe8") ||
    low.startsWith("fe9") ||
    low.startsWith("fea") ||
    low.startsWith("feb") ||
    low.startsWith("ff")
  );
}

/**
 * Refuses URLs that resolve to internal addresses (spec M-22: a changemaker admin could
 * aim a webhook at internal services). Local development and tests allow them.
 */
export async function assertPublicTarget(url: string, allowPrivate: boolean): Promise<void> {
  if (allowPrivate) return;
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    throw new DeliveryError("Invalid webhook URL");
  }
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length) throw new DeliveryError(`Could not resolve ${host}`);
  if (addresses.some(isPrivateAddress))
    throw new DeliveryError("Webhook URL points to a private or internal address");
}

/**
 * The real sender: JSON body as Python's requests wrote it, the event header, and the
 * signature header when a secret is set. Redirects are not followed, so a public URL
 * cannot bounce the request inward.
 */
export function httpDeliver(opts: { allowPrivate: boolean }): Deliver {
  return async (target, payload) => {
    if (!target.url) throw new DeliveryError(`Webhook ${target.id} has no URL`);
    await assertPublicTarget(target.url, opts.allowPrivate);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "Dembrane-Webhook/1.0",
      "X-Webhook-Event": String(payload.event ?? "unknown"),
    };
    if (target.secret) headers["X-Webhook-Signature"] = signature(payload, target.secret);
    const res = await fetch(target.url, {
      method: "POST",
      headers,
      body: pythonJson(payload),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { status: res.status, text: await res.text() };
  };
}
