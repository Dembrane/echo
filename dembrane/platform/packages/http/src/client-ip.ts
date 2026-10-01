import { timingSafeEqual } from "node:crypto";

/** Set by our own web server on the requests it forwards: the caller's address as it resolved it. */
export const CLIENT_IP_HEADER = "x-dembrane-client-ip";
/** Proves a forwarded request came from our web server; without it CLIENT_IP_HEADER is ignored. */
export const PROXY_SECRET_HEADER = "x-dembrane-proxy-secret";

export interface ClientIpOptions {
  /**
   * Addresses or CIDR ranges of the proxies in front of this process that append to
   * X-Forwarded-For (the load balancer). They are skipped when reading the chain.
   */
  readonly trustedProxies?: readonly string[] | undefined;
  /** Shared with the web server; a request carrying it is believed about CLIENT_IP_HEADER. */
  readonly proxySecret?: string | undefined;
}

interface HeaderReader {
  get(name: string): string | null;
}

/**
 * The address a request came from. Each proxy appends the address it saw to
 * X-Forwarded-For, so only the right end of the chain is ours: the answer is the rightmost
 * entry that is not one of our proxies. Everything left of it is whatever the caller sent.
 * The platform in front of the process (Cloud Run, an ingress) always appends the
 * connecting address; without a chain the peer address is used.
 *
 * Our web server forwards /api from a platform address we cannot list, so it resolves the
 * address itself and passes it on with the shared secret.
 */
export function resolveClientIp(
  headers: HeaderReader,
  peer: string | null | undefined,
  opts: ClientIpOptions = {},
): string {
  if (opts.proxySecret) {
    const given = headers.get(PROXY_SECRET_HEADER);
    const ip = headers.get(CLIENT_IP_HEADER)?.trim();
    if (given && ip && sameSecret(given, opts.proxySecret)) return ip;
  }
  const trusted = (opts.trustedProxies ?? []).map(parseRange).filter((r) => r !== null);
  const chain = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  for (let i = chain.length - 1; i >= 0; i--) {
    const hop = chain[i] as string;
    if (!trusted.some((r) => inRange(hop, r))) return hop;
  }
  return peer?.trim() || "unknown";
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface Range {
  readonly bits: bigint;
  readonly size: number;
  readonly prefix: number;
}

function parseRange(entry: string): Range | null {
  const [address, prefix] = entry.trim().split("/");
  const parsed = parseAddress(address ?? "");
  if (!parsed) return null;
  const length = prefix === undefined ? parsed.size : Number(prefix);
  if (!Number.isInteger(length) || length < 0 || length > parsed.size) return null;
  return { bits: parsed.bits, size: parsed.size, prefix: length };
}

function inRange(address: string, range: Range): boolean {
  const parsed = parseAddress(address);
  if (!parsed || parsed.size !== range.size) return false;
  const shift = BigInt(range.size - range.prefix);
  return parsed.bits >> shift === range.bits >> shift;
}

/** An IPv4 or IPv6 address as a number; an IPv4-mapped IPv6 address counts as IPv4. */
function parseAddress(text: string): { bits: bigint; size: number } | null {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(text);
  const v4 = mapped ? (mapped[1] as string) : text;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) {
    let bits = 0n;
    for (const part of v4.split(".")) {
      const n = Number(part);
      if (n > 255) return null;
      bits = (bits << 8n) | BigInt(n);
    }
    return { bits, size: 32 };
  }
  if (!text.includes(":") || !/^[0-9a-f:]+$/i.test(text)) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  let bits = 0n;
  for (const g of groups) {
    if (g.length === 0 || g.length > 4) return null;
    bits = (bits << 16n) | BigInt(Number.parseInt(g, 16));
  }
  return { bits, size: 128 };
}
