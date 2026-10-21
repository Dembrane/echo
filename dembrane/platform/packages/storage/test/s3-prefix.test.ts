import { afterAll, expect, test } from "bun:test";
import { S3Storage } from "../src";

// A stand-in bucket that records the path of every request, so the test sees the key the
// store actually sends. Path-style: /<bucket>/<key>.
const objects = new Map<string, Uint8Array>();
const seen: string[] = [];
const bucket = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const path = decodeURIComponent(new URL(req.url).pathname);
    seen.push(`${req.method} ${path}`);
    const body = objects.get(path);
    switch (req.method) {
      case "PUT":
        objects.set(path, new Uint8Array(await req.arrayBuffer()));
        return new Response(null, { status: 200 });
      case "DELETE":
        objects.delete(path);
        return new Response(null, { status: 204 });
      case "HEAD":
        return body
          ? new Response(null, { headers: { "content-length": String(body.length) } })
          : new Response(null, { status: 404 });
      default:
        return body ? new Response(body) : new Response("NoSuchKey", { status: 404 });
    }
  },
});
afterAll(() => bucket.stop());

const store = (prefix?: string) =>
  new S3Storage({
    endpoint: `http://127.0.0.1:${bucket.port}`,
    bucket: "b",
    region: "auto",
    accessKeyId: "k",
    secretAccessKey: "s",
    prefix,
  });

test("a prefix is applied to every key the store sends to the bucket", async () => {
  const s = store("pr-12");
  seen.length = 0;
  await s.put("conversation/c1/a.mp3", "hello", "audio/mpeg");
  expect(await s.exists("conversation/c1/a.mp3")).toBe(true);
  expect(await (await s.get("conversation/c1/a.mp3"))?.text()).toBe("hello");
  expect(await s.size("conversation/c1/a.mp3")).toBe(5);
  await s.delete("conversation/c1/a.mp3");
  expect(await s.exists("conversation/c1/a.mp3")).toBe(false);

  expect(seen.length).toBeGreaterThan(0);
  for (const line of seen) expect(line).toMatch(/^[A-Z]+ \/b\/pr-12\/conversation\/c1\/a\.mp3$/);
  expect(objects.size).toBe(0);
});

test("presigned URLs and form uploads name the prefixed key", () => {
  const s = store("pr-12/");
  const put = new URL(s.presignUpload("x/y.bin", { contentType: "a/b", expiresInSeconds: 60 }));
  const get = new URL(s.presignDownload("x/y.bin", { expiresInSeconds: 60 }));
  expect(put.pathname).toBe("/b/pr-12/x/y.bin");
  expect(get.pathname).toBe("/b/pr-12/x/y.bin");
  const post = s.presignPost("x/y.bin", {
    contentType: "a/b",
    maxBytes: 10,
    expiresInSeconds: 60,
  });
  expect(post.fields.key).toBe("pr-12/x/y.bin");
});

test("no prefix writes at the bucket root, as before", async () => {
  const s = store();
  seen.length = 0;
  await s.put("root.txt", "x");
  expect(seen).toEqual(["PUT /b/root.txt"]);
  await s.delete("root.txt");
});

test("a prefix that could escape the bucket is refused; bad keys still are", async () => {
  for (const bad of ["../x", "/abs", "a//b"]) expect(() => store(bad)).toThrow(/invalid storage/);
  await expect(store("pr-1").put("../x", "x")).rejects.toThrow("invalid storage key");
});
