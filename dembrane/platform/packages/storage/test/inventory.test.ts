import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FilesystemStorage,
  parseListing,
  parseVersioning,
  parseVersions,
  S3Storage,
  signedRequestHeaders,
} from "../src";

describe("signed requests", () => {
  // The GET Object example in Amazon's SigV4 documentation.
  test("match the documented signature", () => {
    const h = signedRequestHeaders({
      method: "GET",
      path: "/test.txt",
      query: [],
      headers: { host: "examplebucket.s3.amazonaws.com", range: "bytes=0-9" },
      region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  // The list objects example in the same documentation.
  test("sort and encode the query", () => {
    const h = signedRequestHeaders({
      method: "GET",
      path: "/",
      query: [
        ["prefix", "J"],
        ["max-keys", "2"],
      ],
      headers: { host: "examplebucket.s3.amazonaws.com" },
      region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(h.authorization).toContain(
      "Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
    );
  });
});

describe("listing answers", () => {
  test("objects, with escaped keys and the next token", () => {
    const page = parseListing(`<?xml version="1.0"?><ListBucketResult>
      <IsTruncated>true</IsTruncated><NextContinuationToken>tok&amp;1</NextContinuationToken>
      <Contents><Key>a/b &amp; c.mp3</Key><LastModified>2026-10-01T10:00:00.000Z</LastModified><Size>12</Size></Contents>
      <Contents><Key>a/d.mp3</Key><LastModified>2026-10-02T10:00:00.000Z</LastModified><Size>7</Size></Contents>
    </ListBucketResult>`);
    expect(page.items.map((o) => [o.key, o.size])).toEqual([
      ["a/b & c.mp3", 12],
      ["a/d.mp3", 7],
    ]);
    expect(page.next).toEqual({ "continuation-token": "tok&1" });
  });

  test("versions and delete markers, and the markers for the next page", () => {
    const page = parseVersions(`<ListVersionsResult><IsTruncated>true</IsTruncated>
      <NextKeyMarker>k2</NextKeyMarker><NextVersionIdMarker>v9</NextVersionIdMarker>
      <Version><Key>k1</Key><VersionId>v1</VersionId><IsLatest>false</IsLatest><Size>5</Size></Version>
      <DeleteMarker><Key>k1</Key><VersionId>v2</VersionId><IsLatest>true</IsLatest></DeleteMarker>
    </ListVersionsResult>`);
    expect(page.items.map((v) => [v.versionId, v.isDeleteMarker, v.isLatest, v.size])).toEqual([
      ["v1", false, false, 5],
      ["v2", true, true, 0],
    ]);
    expect(page.next).toEqual({ "key-marker": "k2", "version-id-marker": "v9" });
    expect(
      parseVersions("<ListVersionsResult><IsTruncated>false</IsTruncated></ListVersionsResult>")
        .next,
    ).toBeNull();
  });

  test("versioning states", () => {
    expect(
      parseVersioning(
        "<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>",
      ),
    ).toBe("enabled");
    expect(
      parseVersioning(
        "<VersioningConfiguration><Status>Suspended</Status></VersioningConfiguration>",
      ),
    ).toBe("suspended");
    expect(parseVersioning("<VersioningConfiguration/>")).toBe("off");
  });
});

/**
 * A stand-in bucket that keeps versions: a plain DELETE adds a marker and keeps the bytes,
 * DELETE with versionId removes that version. Pages hold two entries, to prove paging.
 */
function versionedBucket(versioned: boolean) {
  type V = { key: string; id: string; size: number; marker: boolean };
  const store = new Map<string, V[]>();
  let n = 0;
  const calls: string[] = [];
  const put = (key: string, size: number) => {
    const list = store.get(key) ?? [];
    list.push({ key, id: versioned ? `v${++n}` : "null", size, marker: false });
    store.set(key, versioned ? list : list.slice(-1));
  };
  const handler = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname);
    const q = url.searchParams;
    calls.push(`${init?.method} ${path}${url.search}`);
    expect(new Headers(init?.headers).get("authorization")).toContain("AWS4-HMAC-SHA256");
    if (init?.method === "DELETE") {
      const key = path.replace(/^\/bkt\//, "");
      const id = q.get("versionId");
      const rest = (store.get(key) ?? []).filter((v) => v.id !== id);
      if (rest.length) store.set(key, rest);
      else store.delete(key);
      return new Response(null, { status: 204 });
    }
    if (q.has("versioning"))
      return new Response(
        `<VersioningConfiguration>${versioned ? "<Status>Enabled</Status>" : ""}</VersioningConfiguration>`,
      );
    const prefix = q.get("prefix") ?? "";
    const all = [...store.values()].flat().filter((v) => v.key.startsWith(prefix));
    if (q.has("versions")) {
      const from = Number(q.get("key-marker") ?? 0);
      const slice = all.slice(from, from + 2);
      const more = from + 2 < all.length;
      return new Response(
        `<ListVersionsResult><IsTruncated>${more}</IsTruncated>${
          more
            ? `<NextKeyMarker>${from + 2}</NextKeyMarker><NextVersionIdMarker>x</NextVersionIdMarker>`
            : ""
        }${slice.map((v) => `<Version><Key>${v.key}</Key><VersionId>${v.id}</VersionId><IsLatest>true</IsLatest><Size>${v.size}</Size></Version>`).join("")}</ListVersionsResult>`,
      );
    }
    const current = all
      .map((v) => v)
      .filter((v, i, a) => a.findLastIndex((x) => x.key === v.key) === i);
    const from = Number(q.get("continuation-token") ?? 0);
    const slice = current.slice(from, from + 2);
    const more = from + 2 < current.length;
    return new Response(
      `<ListBucketResult><IsTruncated>${more}</IsTruncated>${
        more ? `<NextContinuationToken>${from + 2}</NextContinuationToken>` : ""
      }${slice.map((v) => `<Contents><Key>${v.key}</Key><Size>${v.size}</Size></Contents>`).join("")}</ListBucketResult>`,
    );
  }) as unknown as typeof fetch;
  return { store, put, calls, handler };
}

describe("an S3 bucket's inventory", () => {
  const make = (versioned: boolean, prefix?: string) => {
    const b = versionedBucket(versioned);
    const s3 = new S3Storage({
      endpoint: "https://ams3.example.test",
      bucket: "bkt",
      region: "ams3",
      accessKeyId: "k",
      secretAccessKey: "s",
      prefix,
      fetch: b.handler,
    });
    return { b, s3 };
  };
  const collect = async <T>(it: AsyncIterable<T>) => {
    const out: T[] = [];
    for await (const x of it) out.push(x);
    return out;
  };

  test("lists across pages and reports the versioning state", async () => {
    const { b, s3 } = make(true);
    for (const k of [
      "conversation/1/a.mp3",
      "conversation/1/b.mp3",
      "conversation/1/c.mp3",
      "other/x",
    ])
      b.put(k, 10);
    expect((await collect(s3.list("conversation/1/"))).map((o) => o.key)).toEqual([
      "conversation/1/a.mp3",
      "conversation/1/b.mp3",
      "conversation/1/c.mp3",
    ]);
    expect(await s3.versioning()).toBe("enabled");
  });

  test("lists every version and removes them one by one", async () => {
    const { b, s3 } = make(true);
    b.put("k/a.mp3", 5);
    b.put("k/a.mp3", 6);
    b.put("k/b.mp3", 7);
    const versions = await collect(s3.versions("k/"));
    expect(versions.map((v) => [v.key, v.versionId, v.size])).toEqual([
      ["k/a.mp3", "v1", 5],
      ["k/a.mp3", "v2", 6],
      ["k/b.mp3", "v3", 7],
    ]);
    for (const v of versions.filter((x) => x.key === "k/a.mp3"))
      await s3.deleteVersion(v.key, v.versionId);
    expect([...b.store.keys()]).toEqual(["k/b.mp3"]);
    expect(b.calls.filter((c) => c.startsWith("DELETE")).sort()).toEqual([
      "DELETE /bkt/k/a.mp3?versionId=v1",
      "DELETE /bkt/k/a.mp3?versionId=v2",
    ]);
  });

  test("an unversioned bucket has no versions to list", async () => {
    const { b, s3 } = make(false);
    b.put("k/a.mp3", 5);
    expect(await s3.versioning()).toBe("off");
    expect(await collect(s3.versions("k/"))).toEqual([]);
  });

  test("a deployment prefix goes on requests and comes off answers", async () => {
    const { b, s3 } = make(true, "pr-3");
    b.put("pr-3/k/a.mp3", 5);
    b.put("pr-4/k/a.mp3", 5);
    expect((await collect(s3.list("k/"))).map((o) => o.key)).toEqual(["k/a.mp3"]);
    expect((await collect(s3.versions("k/"))).map((o) => o.key)).toEqual(["k/a.mp3"]);
  });

  test("an error answer names what failed", async () => {
    const s3 = new S3Storage({
      endpoint: "https://x.example.test",
      bucket: "bkt",
      region: "r",
      accessKeyId: "k",
      secretAccessKey: "s",
      fetch: (async () =>
        new Response("<Error>AccessDenied</Error>", { status: 403 })) as unknown as typeof fetch,
    });
    await expect(s3.versioning()).rejects.toThrow("403");
  });
});

describe("the filesystem store's inventory", () => {
  const root = mkdtempSync(join(tmpdir(), "echo-inventory-"));
  const fs = new FilesystemStorage(root, "http://localhost");
  afterAll(() => undefined);
  test("lists by prefix, has no versions, and a version delete is a delete", async () => {
    await fs.put("c/1/a.mp3", "12345");
    await fs.put("c/1/sub/b.mp3", "123");
    await fs.put("c/2/a.mp3", "1");
    const keys: [string, number][] = [];
    for await (const o of fs.list("c/1/")) keys.push([o.key, o.size]);
    expect(keys.sort()).toEqual([
      ["c/1/a.mp3", 5],
      ["c/1/sub/b.mp3", 3],
    ]);
    expect(await fs.versioning()).toBe("off");
    await fs.deleteVersion("c/1/a.mp3", "null");
    expect(await fs.exists("c/1/a.mp3")).toBe(false);
  });
});
