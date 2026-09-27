import { createHmac } from "node:crypto";

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
        { acl: "private" },
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
    acl: "private",
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
