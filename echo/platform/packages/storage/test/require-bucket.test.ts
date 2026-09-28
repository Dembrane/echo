import { expect, test } from "bun:test";
import { FilesystemStorage, requireBucket, S3Storage } from "../src";

// A deployed process with no bucket would write files to its own disk, where the API on
// another instance answers 404 for them. It refuses to start instead.
test("the filesystem store is refused outside local and test; a bucket is fine anywhere", () => {
  const disk = new FilesystemStorage("/tmp/x", "http://localhost");
  const bucket = new S3Storage({
    endpoint: "https://s3.example",
    bucket: "b",
    region: "auto",
    accessKeyId: "k",
    secretAccessKey: "s",
  });
  for (const env of ["local", "test"])
    expect(() => requireBucket(env, disk, "Files", "FILES_S3_BUCKET")).not.toThrow();
  for (const env of ["preview", "next", "prod"])
    expect(() => requireBucket(env, disk, "Files", "FILES_S3_BUCKET")).toThrow(/FILES_S3_BUCKET/);
  expect(() => requireBucket("prod", bucket, "Files", "FILES_S3_BUCKET")).not.toThrow();
});
