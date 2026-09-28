import { describe } from "bun:test";
import { S3Storage } from "../src";
import { storageContract } from "./contract";

// Runs against a real bucket when credentials are present (CI: GCS preview bucket).
const env = process.env;
const ready =
  env.TEST_S3_ENDPOINT &&
  env.TEST_S3_BUCKET &&
  env.TEST_S3_ACCESS_KEY_ID &&
  env.TEST_S3_SECRET_ACCESS_KEY;
(ready ? describe : describe.skip)("s3", () => {
  storageContract(
    "s3",
    () =>
      new S3Storage({
        endpoint: env.TEST_S3_ENDPOINT as string,
        bucket: env.TEST_S3_BUCKET as string,
        region: env.TEST_S3_REGION ?? "auto",
        accessKeyId: env.TEST_S3_ACCESS_KEY_ID as string,
        secretAccessKey: env.TEST_S3_SECRET_ACCESS_KEY as string,
      }),
    { presignFetch: true },
  );
});
