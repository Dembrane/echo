import { createHash, createHmac } from "node:crypto";

const hmac = (key: string | Buffer, data: string) =>
  createHmac("sha256", key).update(data).digest();

/** AWS Signature Version 4 signing key for S3 in one region and day. */
export function signingKey(secret: string, date: string, region: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  return hmac(kService, "aws4_request");
}

export interface PostPolicyInput {
  readonly bucket: string;
  readonly key: string;
  readonly contentType: string;
  readonly maxBytes: number;
  readonly expiresInSeconds: number;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly now: Date;
}

/**
 * The form fields of a SigV4 POST policy, in the order boto3's generate_presigned_post
 * returns them. S3, Spaces, MinIO and GCS (interoperability) all accept this form.
 * No acl field: objects are private by default on every provider, and GCS refuses any
 * ACL on a bucket with uniform bucket-level access, which ours have.
 */
export function postPolicyFields(p: PostPolicyInput): Record<string, string> {
  const amzDate = p.now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const credential = `${p.accessKeyId}/${day}/${p.region}/s3/aws4_request`;
  const expiration = new Date(p.now.getTime() + p.expiresInSeconds * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  const policy = Buffer.from(
    pythonJson({
      expiration,
      conditions: [
        { "Content-Type": p.contentType },
        ["content-length-range", 0, p.maxBytes],
        { bucket: p.bucket },
        { key: p.key },
        { "x-amz-algorithm": "AWS4-HMAC-SHA256" },
        { "x-amz-credential": credential },
        { "x-amz-date": amzDate },
      ],
    }),
  ).toString("base64");
  const signature = createHmac("sha256", signingKey(p.secretAccessKey, day, p.region))
    .update(policy)
    .digest("hex");
  return {
    "Content-Type": p.contentType,
    key: p.key,
    "x-amz-algorithm": "AWS4-HMAC-SHA256",
    "x-amz-credential": credential,
    "x-amz-date": amzDate,
    policy,
    "x-amz-signature": signature,
  };
}

/** json.dumps with Python's default separators, so the policy is byte-identical to boto3's. */
function pythonJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(pythonJson).join(", ")}]`;
  if (v && typeof v === "object")
    return `{${Object.entries(v)
      .map(([k, x]) => `${JSON.stringify(k)}: ${pythonJson(x)}`)
      .join(", ")}}`;
  return JSON.stringify(v);
}

/** sha256 of an empty body, the payload hash of every GET and DELETE. */
export const EMPTY_PAYLOAD_HASH = createHash("sha256").update("").digest("hex");

/** RFC 3986 encoding as SigV4 wants it: only unreserved characters stay. */
export const encodeRfc3986 = (v: string) =>
  encodeURIComponent(v).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

export interface SignedRequestInput {
  readonly method: string;
  /** The request path, already encoded, starting with "/". */
  readonly path: string;
  readonly query: readonly (readonly [string, string])[];
  /** Headers to sign besides the date and payload hash; "host" is required. */
  readonly headers: Readonly<Record<string, string>>;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly now: Date;
  readonly payloadHash?: string;
}

/**
 * The headers of a SigV4 header-signed S3 request, for the calls Bun's S3 client does not
 * make (listing versions, deleting one version). Returns every header to send, the
 * signed ones and "authorization".
 */
export function signedRequestHeaders(r: SignedRequestInput): Record<string, string> {
  const amzDate = r.now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const payloadHash = r.payloadHash ?? EMPTY_PAYLOAD_HASH;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers)) headers[k.toLowerCase()] = v.trim();
  headers["x-amz-content-sha256"] = payloadHash;
  headers["x-amz-date"] = amzDate;
  const names = Object.keys(headers).sort();
  const canonicalQuery = r.query
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonical = [
    r.method,
    r.path,
    canonicalQuery,
    `${names.map((n) => `${n}:${headers[n]}\n`).join("")}`,
    names.join(";"),
    payloadHash,
  ].join("\n");
  const scope = `${day}/${r.region}/s3/aws4_request`;
  const toSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonical).digest("hex"),
  ].join("\n");
  const signature = createHmac("sha256", signingKey(r.secretAccessKey, day, r.region))
    .update(toSign)
    .digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${r.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
  return headers;
}
