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

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export interface SignInput {
  readonly method: string;
  readonly url: URL;
  /** Lowercase names; host, x-amz-date and x-amz-content-sha256 are added. */
  readonly headers: Readonly<Record<string, string>>;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly now: Date;
}

/** The headers of a SigV4 header-signed request with an empty body (path already encoded). */
export function signedHeaders(p: SignInput): Record<string, string> {
  const amzDate = p.now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...p.headers,
    host: p.url.host,
    "x-amz-content-sha256": EMPTY_SHA256,
    "x-amz-date": amzDate,
  };
  const names = Object.keys(headers).sort();
  const query = [...p.url.searchParams]
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .sort()
    .join("&");
  const canonical = [
    p.method,
    p.url.pathname,
    query,
    names.map((n) => `${n}:${String(headers[n]).trim()}\n`).join(""),
    names.join(";"),
    EMPTY_SHA256,
  ].join("\n");
  const scope = `${day}/${p.region}/s3/aws4_request`;
  const toSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonical).digest("hex"),
  ].join("\n");
  const signature = createHmac("sha256", signingKey(p.secretAccessKey, day, p.region))
    .update(toSign)
    .digest("hex");
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${p.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
  };
}
