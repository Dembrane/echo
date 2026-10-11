import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Tokens of connected apps at rest: AES-256-GCM under CONNECTOR_TOKEN_KEY, stored as
 * `v1.<iv>.<tag>.<ciphertext>` in base64url. The version prefix lets a later key or cipher
 * sit beside this one. A value that does not open (another key, tampered) throws.
 */
export interface Sealer {
  seal(plain: string): string;
  open(sealed: string): string;
}

export function tokenSealer(base64Key: string): Sealer {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32) throw new Error("CONNECTOR_TOKEN_KEY must be 32 bytes, base64");
  return {
    seal(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return ["v1", iv, cipher.getAuthTag(), body].map(b64).join(".");
    },
    open(sealed) {
      const [version, iv, tag, body] = sealed.split(".");
      if (version !== "v1" || !iv || !tag || body === undefined)
        throw new Error("not a sealed connector token");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(body, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}

function b64(v: string | Buffer): string {
  return typeof v === "string" ? v : v.toString("base64url");
}

/** What the OAuth `state` carries through the app's sign-in page and back. */
export interface OAuthState {
  /** The signed-in person who started it; the callback must come from the same person. */
  readonly user: string;
  readonly project: string;
  readonly provider: string;
  /** Unix seconds. */
  readonly exp: number;
  readonly nonce: string;
}

const STATE_TTL_SECONDS = 10 * 60;

/** HMAC-signed state, so the callback cannot be replayed for another person or project. */
export function signState(secret: string, s: Omit<OAuthState, "exp" | "nonce">, now: Date): string {
  const full: OAuthState = {
    ...s,
    exp: Math.floor(now.getTime() / 1000) + STATE_TTL_SECONDS,
    nonce: randomBytes(9).toString("base64url"),
  };
  const body = Buffer.from(JSON.stringify(full)).toString("base64url");
  return `${body}.${mac(secret, body)}`;
}

/** The state's contents, or null when it is malformed, tampered with or expired. */
export function readState(secret: string, raw: string, now: Date): OAuthState | null {
  const [body, sig] = raw.split(".");
  if (!body || !sig) return null;
  const want = Buffer.from(mac(secret, body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as OAuthState;
    if (typeof s.exp !== "number" || s.exp < now.getTime() / 1000) return null;
    return s;
  } catch {
    return null;
  }
}

function mac(secret: string, body: string): string {
  return createHmac("sha256", `connector-state:${secret}`).update(body).digest("base64url");
}
