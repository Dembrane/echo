/**
 * How audio objects are named in rows. The Python API stored chunk and merged audio as
 * "<endpoint>/<bucket>/<key>" and parsed the key back out when reading; both APIs share
 * the rows during the migration, so the platform writes and reads the same form.
 */
export class AudioUrls {
  private readonly prefix: string;

  constructor(
    readonly endpoint: string,
    readonly bucket: string,
  ) {
    this.prefix = `${endpoint.replace(/\/+$/, "")}/${bucket}/`;
  }

  /** The stored path of an object key. */
  fileUrl(key: string): string {
    return `${this.prefix}${key}`;
  }

  /**
   * get_sanitized_s3_key: the object key of a stored path, a full URL on any endpoint,
   * or a bare key. Query strings are dropped; anything that could escape is refused.
   */
  keyOf(fileName: string): string {
    if (!fileName) throw new Error("Empty file name provided to get_sanitized_s3_key");
    const name = fileName.trim().split("?")[0] as string;
    const check = (key: string) => {
      if (key.includes("..") || key.startsWith("/"))
        throw new Error(`Invalid S3 key: path traversal detected in ${key}`);
      return key;
    };
    if (name.startsWith(this.prefix)) return check(name.slice(this.prefix.length));
    if (name.startsWith("http://") || name.startsWith("https://")) {
      const parts = name.split("/");
      if (parts.length >= 5) return check(parts.slice(4).join("/"));
    } else if (name.startsWith("/")) {
      const key = name.replace(/^\/+/, "");
      if (key.includes("..")) throw new Error(`Invalid S3 key: path traversal detected in ${key}`);
      return key;
    }
    if (name.includes(".."))
      throw new Error(`Invalid file name: path traversal detected in ${name}`);
    return name;
  }
}

/** sanitize_filename_component: letters, digits, dash and underscore only. */
export function sanitizeFilenameComponent(v: string): string {
  return [...v].filter((c) => /[\p{L}\p{N}_-]/u.test(c)).join("");
}
