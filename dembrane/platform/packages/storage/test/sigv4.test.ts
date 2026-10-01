import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemStorage, localStorageHandler, postPolicyFields } from "../src";

test("a POST policy is byte-identical to boto3's generate_presigned_post", () => {
  // boto3 1.x with no acl field or condition, region eu, endpoint http://127.0.0.1:9, clock frozen at 2026-09-27T10:11:12Z.
  const fields = postPolicyFields({
    bucket: "parity",
    key: "conversation/c/chunks/x-a.webm",
    contentType: "audio/webm",
    maxBytes: 2048 * 1024 * 1024,
    expiresInSeconds: 3600,
    region: "eu",
    accessKeyId: "AKID",
    secretAccessKey: "SECRET",
    now: new Date("2026-09-27T10:11:12Z"),
  });
  expect(fields).toEqual({
    "Content-Type": "audio/webm",
    key: "conversation/c/chunks/x-a.webm",
    "x-amz-algorithm": "AWS4-HMAC-SHA256",
    "x-amz-credential": "AKID/20260927/eu/s3/aws4_request",
    "x-amz-date": "20260927T101112Z",
    policy:
      "eyJleHBpcmF0aW9uIjogIjIwMjYtMDktMjdUMTE6MTE6MTJaIiwgImNvbmRpdGlvbnMiOiBbeyJDb250ZW50LVR5cGUiOiAiYXVkaW8vd2VibSJ9LCBbImNvbnRlbnQtbGVuZ3RoLXJhbmdlIiwgMCwgMjE0NzQ4MzY0OF0sIHsiYnVja2V0IjogInBhcml0eSJ9LCB7ImtleSI6ICJjb252ZXJzYXRpb24vYy9jaHVua3MveC1hLndlYm0ifSwgeyJ4LWFtei1hbGdvcml0aG0iOiAiQVdTNC1ITUFDLVNIQTI1NiJ9LCB7IngtYW16LWNyZWRlbnRpYWwiOiAiQUtJRC8yMDI2MDkyNy9ldS9zMy9hd3M0X3JlcXVlc3QifSwgeyJ4LWFtei1kYXRlIjogIjIwMjYwOTI3VDEwMTExMloifV19",
    "x-amz-signature": "3ffd93ca218e32506833f34f6c0fda77c52a83460ccb48eb66591b0134683f7b",
  });
});

test("the local handler takes the portal's form post and serves the file back", async () => {
  const root = mkdtempSync(join(tmpdir(), "echo-local-"));
  const s = new FilesystemStorage(root, "http://local.test");
  const handle = localStorageHandler(s);
  const post = s.presignPost("conversation/c/chunks/a.webm", {
    contentType: "audio/webm",
    maxBytes: 1000,
    expiresInSeconds: 60,
  });
  const form = new FormData();
  for (const [k, v] of Object.entries(post.fields)) form.append(k, v);
  form.append("file", new Blob(["abc"], { type: "audio/webm" }), "a.webm");
  expect((await handle(new Request(post.url, { method: "POST", body: form }))).status).toBe(204);
  const get = s.presignDownload("conversation/c/chunks/a.webm", { expiresInSeconds: 60 });
  expect(await (await handle(new Request(get))).text()).toBe("abc");
  const put = s.presignUpload("p/probe", { contentType: "text/plain", expiresInSeconds: 60 });
  expect((await handle(new Request(put, { method: "PUT", body: "probe" }))).status).toBe(200);
  expect(await (await s.get("p/probe"))?.text()).toBe("probe");
});
