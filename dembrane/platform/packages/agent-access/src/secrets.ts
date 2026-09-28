import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Token and client-secret handling, byte-compatible with the Python API so every token it
 * issued and every client it registered keeps working after cutover:
 *   - tokens are `<prefix><token_urlsafe(32)>` and only their SHA-256 hex is stored;
 *   - a confidential client's secret is stored encrypted as a Fernet token under a key
 *     derived from Directus's SECRET, because the token endpoint compares the plain secret.
 * Rotating that secret makes every stored client secret unreadable; those clients then
 * fail authentication and must register again.
 */

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Python's secrets.token_urlsafe(32): 32 random bytes, base64url without padding. */
export function mintToken(prefix: string): string {
  return prefix + randomBytes(32).toString("base64url");
}

/** Python's secrets.token_hex(32): the client secret handed out at registration. */
export function mintClientSecret(): string {
  return randomBytes(32).toString("hex");
}

/** Constant-time string comparison, as hmac.compare_digest over the UTF-8 bytes. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Fernet (the `cryptography` package's spec) keyed like store._fernet():
 * urlsafe_b64encode(sha256("agent_client:" + secret)). The first 16 bytes sign, the last
 * 16 encrypt with AES-128-CBC.
 */
export class ClientSecretBox {
  private readonly signing: Buffer;
  private readonly encryption: Buffer;

  constructor(directusSecret: string) {
    const key = createHash("sha256").update(`agent_client:${directusSecret}`).digest();
    this.signing = key.subarray(0, 16);
    this.encryption = key.subarray(16, 32);
  }

  encrypt(plain: string, now = new Date(), iv = randomBytes(16)): string {
    const cipher = createCipheriv("aes-128-cbc", this.encryption, iv);
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const ts = Buffer.alloc(8);
    ts.writeBigUInt64BE(BigInt(Math.floor(now.getTime() / 1000)));
    const head = Buffer.concat([Buffer.from([0x80]), ts, iv, body]);
    const mac = createHmac("sha256", this.signing).update(head).digest();
    // Fernet tokens are base64url with padding, as base64.urlsafe_b64encode writes them.
    return Buffer.concat([head, mac]).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  }

  /** The plain secret, or null for a token that is malformed or signed with another key. */
  decrypt(token: string): string | null {
    let raw: Buffer;
    try {
      raw = Buffer.from(token.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    } catch {
      return null;
    }
    if (raw.length < 1 + 8 + 16 + 16 + 32 || raw[0] !== 0x80) return null;
    const head = raw.subarray(0, raw.length - 32);
    const mac = raw.subarray(raw.length - 32);
    const expected = createHmac("sha256", this.signing).update(head).digest();
    if (!timingSafeEqual(mac, expected)) return null;
    try {
      const decipher = createDecipheriv("aes-128-cbc", this.encryption, head.subarray(9, 25));
      return Buffer.concat([decipher.update(head.subarray(25)), decipher.final()]).toString("utf8");
    } catch {
      return null;
    }
  }
}
