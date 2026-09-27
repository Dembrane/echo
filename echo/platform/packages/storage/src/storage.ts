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
