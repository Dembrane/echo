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
