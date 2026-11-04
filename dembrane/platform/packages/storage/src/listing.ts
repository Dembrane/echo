import type { ListedObject, ObjectVersion, Versioning } from "./storage";

/**
 * The few S3 XML answers a retention job reads: object listings, version listings and the
 * versioning state. Every provider we use (Spaces, Scaleway, GCS interoperability) answers
 * in this shape, and the answers are flat, so a small reader is enough.
 */
const xmlText = (v: string) =>
  v
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

const blocks = (xml: string, name: string) =>
  [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g"))].map((m) => m[1] as string);

const field = (xml: string, name: string) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? xmlText(m[1] as string) : null;
};

const date = (v: string | null) => (v ? new Date(v) : null);

export interface Page<T> {
  readonly items: T[];
  readonly truncated: boolean;
  /** Where the next page starts; null on the last page. */
  readonly next: Readonly<Record<string, string>> | null;
}

/** ListObjectsV2: keys with sizes, and the token for the next page. */
export function parseListing(xml: string): Page<ListedObject> {
  const items = blocks(xml, "Contents").map((b) => ({
    key: field(b, "Key") as string,
    size: Number(field(b, "Size") ?? 0),
    lastModified: date(field(b, "LastModified")),
  }));
  const token = field(xml.replace(/<Contents>[\s\S]*?<\/Contents>/g, ""), "NextContinuationToken");
  const truncated = field(xml, "IsTruncated") === "true";
  return {
    items,
    truncated,
    next: truncated && token ? { "continuation-token": token } : null,
  };
}

/** ListObjectVersions: versions and delete markers, in the order the bucket lists them. */
export function parseVersions(xml: string): Page<ObjectVersion> {
  const read = (b: string, isDeleteMarker: boolean): ObjectVersion => ({
    key: field(b, "Key") as string,
    versionId: field(b, "VersionId") ?? "null",
    isLatest: field(b, "IsLatest") === "true",
    isDeleteMarker,
    size: Number(field(b, "Size") ?? 0),
    lastModified: date(field(b, "LastModified")),
  });
  const items = [
    ...blocks(xml, "Version").map((b) => read(b, false)),
    ...blocks(xml, "DeleteMarker").map((b) => read(b, true)),
  ];
  const rest = xml.replace(/<(Version|DeleteMarker)>[\s\S]*?<\/\1>/g, "");
  const truncated = field(rest, "IsTruncated") === "true";
  const keyMarker = field(rest, "NextKeyMarker");
  const versionMarker = field(rest, "NextVersionIdMarker");
  const next: Record<string, string> = {};
  if (keyMarker) next["key-marker"] = keyMarker;
  if (versionMarker) next["version-id-marker"] = versionMarker;
  return { items, truncated, next: truncated && keyMarker ? next : null };
}

/** GetBucketVersioning: no Status element means it was never turned on. */
export function parseVersioning(xml: string): Versioning {
  const status = field(xml, "Status");
  return status === "Enabled" ? "enabled" : status === "Suspended" ? "suspended" : "off";
}
