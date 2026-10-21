import { expect, test } from "bun:test";
import type { ObjectStorage } from "../src";

/** Every ObjectStorage implementation must pass this suite. */
export function storageContract(
  name: string,
  make: () => ObjectStorage,
  opts: { presignFetch?: boolean } = {},
) {
  const prefix = `contract/${crypto.randomUUID()}`;

  test(`${name}: put, get, size, exists, delete`, async () => {
    const s = make();
    const key = `${prefix}/a/b.txt`;
    await s.put(key, "hello", "text/plain");
    expect(await s.exists(key)).toBe(true);
    expect(await (await s.get(key))?.text()).toBe("hello");
    expect(await s.size(key)).toBe(5);
    await s.delete(key);
    expect(await s.exists(key)).toBe(false);
    expect(await s.get(key)).toBeNull();
    expect(await s.size(key)).toBeNull();
  });

  test(`${name}: binary round-trips unchanged`, async () => {
    const s = make();
    const bytes = crypto.getRandomValues(new Uint8Array(4096));
    await s.put(`${prefix}/bin`, bytes, "application/octet-stream");
    expect(new Uint8Array(await ((await s.get(`${prefix}/bin`)) as Blob).arrayBuffer())).toEqual(
      bytes,
    );
    await s.delete(`${prefix}/bin`);
  });

  test(`${name}: keys that could escape are refused`, async () => {
    const s = make();
    for (const bad of ["../x", "/abs", "a/../../b", ""]) {
      await expect(s.put(bad, "x")).rejects.toThrow("invalid storage key");
    }
  });

  if (opts.presignFetch) {
    test(`${name}: a browser can PUT to a presigned URL and GET it back`, async () => {
      const s = make();
      const key = `${prefix}/presigned.webm`;
      const put = await fetch(
        s.presignUpload(key, { contentType: "audio/webm", expiresInSeconds: 60 }),
        {
          method: "PUT",
          headers: { "content-type": "audio/webm" },
          body: "audio-bytes",
        },
      );
      expect(put.status).toBeLessThan(300);
      const got = await fetch(s.presignDownload(key, { expiresInSeconds: 60 }));
      expect(await got.text()).toBe("audio-bytes");
      await s.delete(key);
    });
  }
}
