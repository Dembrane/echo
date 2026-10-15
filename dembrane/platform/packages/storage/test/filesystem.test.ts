import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { FilesystemStorage, localStorageHandler } from "../src";
import { storageContract } from "./contract";

const root = mkdtempSync(join(tmpdir(), "echo-storage-"));
storageContract("filesystem", () => new FilesystemStorage(root, "http://localhost:8080"));

describe("local store answers byte ranges", () => {
  const storage = new FilesystemStorage(root, "http://localhost:8080");
  const handle = localStorageHandler(storage);
  const url = () => storage.presignDownload("audio/range.bin", { expiresInSeconds: 60 });

  test("a range is a 206 with the bytes asked for", async () => {
    await storage.put("audio/range.bin", new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    const mid = await handle(new Request(url(), { headers: { range: "bytes=2-4" } }));
    expect(mid.status).toBe(206);
    expect(mid.headers.get("content-range")).toBe("bytes 2-4/10");
    expect([...new Uint8Array(await mid.arrayBuffer())]).toEqual([2, 3, 4]);
    const open = await handle(new Request(url(), { headers: { range: "bytes=8-" } }));
    expect([...new Uint8Array(await open.arrayBuffer())]).toEqual([8, 9]);
    const tail = await handle(new Request(url(), { headers: { range: "bytes=-3" } }));
    expect([...new Uint8Array(await tail.arrayBuffer())]).toEqual([7, 8, 9]);
  });

  test("a range past the end is refused and a plain read says ranges are welcome", async () => {
    const past = await handle(new Request(url(), { headers: { range: "bytes=50-60" } }));
    expect(past.status).toBe(416);
    const all = await handle(new Request(url()));
    expect(all.status).toBe(200);
    expect(all.headers.get("accept-ranges")).toBe("bytes");
  });
});
