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
  const [a = 0, b = 0, c = 0] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/** The eight 16-bit groups of an IPv6 address, an embedded dotted IPv4 tail included. */
function v6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase().replace(/%.*$/, "");
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail?.[1]) {
    if (isIP(tail[1]) !== 4) return null;
    const [a = 0, b = 0, c = 0, d = 0] = tail[1].split(".").map(Number);
    text = `${text.slice(0, -tail[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  const all = [...head, ...Array(fill).fill("0"), ...rest];
  if (all.length !== 8) return null;
  const groups = all.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN));
  return groups.some(Number.isNaN) ? null : groups;
}

const v4Of = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/**
 * Loopback, private, link-local, carrier-grade NAT, multicast and reserved addresses. An
 * IPv6 address that carries an IPv4 one (mapped, compatible, NAT64, 6to4) is judged by
 * the IPv4 address it reaches: the URL parser rewrites [::ffff:127.0.0.1] to
 * [::ffff:7f00:1], which a textual match would let through.
 */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return v4Private(ip);
  const g = v6Groups(ip);
  if (!g) return true;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const zeroTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  // ::, ::1 and IPv4-compatible ::a.b.c.d
  if (zeroTo(6)) return g6 === 0 || v4Private(v4Of(g6, g7));
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-translated ::ffff:0:a.b.c.d
  if (zeroTo(5) && g5 === 0xffff) return v4Private(v4Of(g6, g7));
  if (zeroTo(4) && g4 === 0xffff && g5 === 0) return v4Private(v4Of(g6, g7));
  // NAT64 64:ff9b::/96 and 64:ff9b:1::/48
  if (g0 === 0x64 && g1 === 0xff9b) return g2 !== 0 || v4Private(v4Of(g6, g7));
  // 6to4 2002::/16 carries its IPv4 address in the next two groups.
  if (g0 === 0x2002) return v4Private(v4Of(g1, g2));
  return (
    (g0 & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (g0 & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (g0 & 0xffc0) === 0xfec0 || // site-local fec0::/10
    (g0 & 0xff00) === 0xff00 || // multicast ff00::/8
    (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) || // discard 100::/64
    (g0 === 0x2001 && g1 === 0xdb8) || // documentation 2001:db8::/32
    (g0 === 0x2001 && g1 < 0x200) // Teredo and other IETF special use 2001::/23
  );
}

/** Every address a hostname has. Tests pass their own. */
export type Resolve = (host: string) => Promise<string[]>;

const resolveAll: Resolve = async (host) =>
  (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);

/** The addresses behind a URL's host, resolved once; any internal one refuses the URL. */
async function checkedAddresses(
  url: string,
  allowPrivate: boolean,
  resolve: Resolve = resolveAll,
): Promise<string[]> {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    throw new DeliveryError("Invalid webhook URL");
  }
  const addresses = isIP(host) ? [host] : await resolve(host);
  if (!addresses.length) throw new DeliveryError(`Could not resolve ${host}`);
  if (!allowPrivate && addresses.some(isPrivateAddress))
    throw new DeliveryError("Webhook URL points to a private or internal address");
  return addresses;
}

/**
 * Refuses URLs that resolve to internal addresses (spec M-22: a changemaker admin could
 * aim a webhook at internal services). Local development and tests allow them.
 */
export async function assertPublicTarget(url: string, allowPrivate: boolean): Promise<void> {
  if (allowPrivate) return;
  await checkedAddresses(url, false);
}

/** Bun's codes for a connection that never opened, so nothing was sent on it. */
const NOT_CONNECTED = new Set(["ConnectionRefused", "FailedToOpenSocket"]);

/**
 * fetch for a URL someone else chose. The name is resolved once and the request connects
 * to an address from that answer, so the address that was checked is the address that is
 * reached. The hostname stays in the Host header and in TLS, for SNI and the certificate
 * check. Redirects are never followed: a caller that wants the next hop calls again with
 * its URL, which is then checked the same way.
 */
export async function fetchChecked(
  url: string,
  init: Omit<BunFetchRequestInit, "redirect">,
  opts: { allowPrivate: boolean; resolve?: Resolve },
): Promise<Response> {
  const addresses = await checkedAddresses(url, opts.allowPrivate, opts.resolve);
  const target = new URL(url);
  if (isIP(target.hostname.replace(/^\[|\]$/g, "")))
    return fetch(url, { ...init, redirect: "manual" });
  const headers = new Headers(init.headers);
  headers.set("Host", target.host);
  let failure: unknown;
  for (const address of addresses) {
    const pinned = new URL(url);
    pinned.hostname = isIP(address) === 6 ? `[${address}]` : address;
    try {
      return await fetch(pinned.href, {
        ...init,
        headers,
        redirect: "manual",
        tls: { ...init.tls, serverName: target.hostname },
      });
    } catch (err) {
      // Only a connection that never opened moves on to the next address: nothing was
      // sent, so no receiver gets the request twice.
      if (!NOT_CONNECTED.has((err as { code?: string }).code ?? "")) throw err;
      failure = err;
    }
  }
  throw failure;
}

/**
 * The real sender: JSON body as Python's requests wrote it, the event header, and the
 * signature header when a secret is set. Redirects are not followed, so a public URL
 * cannot bounce the request inward.
 */
export function httpDeliver(opts: { allowPrivate: boolean; resolve?: Resolve }): Deliver {
  return async (target, payload) => {
    if (!target.url) throw new DeliveryError(`Webhook ${target.id} has no URL`);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "Dembrane-Webhook/1.0",
      "X-Webhook-Event": String(payload.event ?? "unknown"),
    };
    if (target.secret) headers["X-Webhook-Signature"] = signature(payload, target.secret);
    const res = await fetchChecked(
      target.url,
      {
        method: "POST",
        headers,
        body: pythonJson(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
      opts,
    );
    return { status: res.status, text: await res.text() };
  };
}
