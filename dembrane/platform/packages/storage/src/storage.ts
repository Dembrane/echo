/**
 * Object storage for audio, uploads and exports. Two implementations share one contract
 * suite: S3 (GCS interoperability, Spaces, MinIO, any S3 provider) and the filesystem for
 * local development and tests.
 */
export interface ObjectStorage {
  put(
    key: string,
    body: Blob | ArrayBuffer | Uint8Array | string,
    contentType?: string,
  ): Promise<void>;
  /** Null when the object does not exist. */
  get(key: string): Promise<Blob | null>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  size(key: string): Promise<number | null>;
  /** A URL a browser can PUT to directly, so uploads never pass through the API. */
  presignUpload(key: string, opts: { contentType: string; expiresInSeconds: number }): string;
  /** A time-limited URL a browser can GET. */
  presignDownload(key: string, opts: { expiresInSeconds: number }): string;
  /**
   * A browser form upload (S3 POST policy): the page posts `fields` plus the file to
   * `url`. The portal uploads audio this way today; the policy pins the key, the
   * content type and a size ceiling, so the URL cannot be reused for anything else.
   */
  presignPost(
    key: string,
    opts: { contentType: string; maxBytes: number; expiresInSeconds: number },
  ): PresignedPost;
}

/** One stored object as a listing shows it; `key` is the bare key, without any deployment prefix. */
export interface ListedObject {
  readonly key: string;
  readonly size: number;
  readonly lastModified: Date | null;
}

/** One version of an object, or the delete marker that hides it. */
export interface ObjectVersion extends ListedObject {
  readonly versionId: string;
  readonly isLatest: boolean;
  readonly isDeleteMarker: boolean;
}

/** Whether a bucket keeps old versions: "off" means a delete is final. */
export type Versioning = "enabled" | "suspended" | "off";

/**
 * What a retention job needs beyond ObjectStorage: to see what is stored, old versions
 * included, and to remove one version for good. A plain delete on a versioned bucket only
 * adds a delete marker and keeps the bytes, so removing audio means removing every version.
 */
export interface ObjectInventory {
  /** Current objects whose key starts with `prefix`. */
  list(prefix: string): AsyncIterable<ListedObject>;
  versioning(): Promise<Versioning>;
  /** Every version and delete marker of keys that start with `prefix`; none while versioning is off. */
  versions(prefix: string): AsyncIterable<ObjectVersion>;
  /** Removes one version permanently (a delete marker included). */
  deleteVersion(key: string, versionId: string): Promise<void>;
}

export interface PresignedPost {
  readonly url: string;
  readonly fields: Readonly<Record<string, string>>;
}

/** Keys are relative, forward-slash paths; anything that could escape the bucket or a directory is refused. */
export function checkKey(key: string): string {
  if (
    !key ||
    key.startsWith("/") ||
    key.includes("..") ||
    key.includes("\\") ||
    key.length > 1024
  ) {
    throw new Error(`invalid storage key: ${JSON.stringify(key)}`);
  }
  return key;
}

/**
 * Outside local development and tests, files must go to a bucket. The filesystem store
 * writes to the disk of whichever machine runs the process, where no other instance, and
 * no later deploy, can read them back. Fails at startup, naming the setting that is missing.
 */
export function requireBucket(
  env: string,
  store: ObjectStorage,
  what: string,
  setting: string,
): void {
  if (env === "local" || env === "test") return;
  if ((store as { kind?: string }).kind === "filesystem")
    throw new Error(
      `${what} would be written to this machine's disk on ${env}: set ${setting} (and its endpoint and keys) so they go to the bucket`,
    );
}
