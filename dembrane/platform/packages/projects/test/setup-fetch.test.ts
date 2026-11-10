import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { isPrivateAddress } from "@dembrane/webhooks";
import { checkUrl, fetchPageText, PageFetchError, visibleText } from "../src/setup/fetch-page";

// ECHO-1043: the linked page is read on our server, bounded on every side. A local server
// stands in for the web. Its 127.0.0.1 is the one private address the tests allow; every
// other private, loopback, link-local, CGNAT and metadata address is refused as in production.

let server: ReturnType<typeof Bun.serve>;
let base = "";
const onlyTestServer = (ip: string) => ip !== "127.0.0.1" && isPrivateAddress(ip);
const opts = { allowPrivate: false, blocked: onlyTestServer };

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/page")
        return new Response(
          `<html><head><title>T</title><script>steal()</script><style>p{}</style></head>
           <body><p>Bewonersavond&nbsp;Strijp-S</p><!-- hidden --><div>Klokgebouw &amp; GGD</div></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      if (path === "/plain")
        return new Response("Agenda\nWelkom door Arne", {
          headers: { "content-type": "text/plain" },
        });
      if (path === "/pdf")
        return new Response("%PDF-1.7", { headers: { "content-type": "application/pdf" } });
      if (path === "/big")
        return new Response(`<p>${"Strijp ".repeat(400_000)}</p>`, {
          headers: { "content-type": "text/html" },
        });
      if (path === "/slow") {
        await Bun.sleep(1_500);
        return new Response("late", { headers: { "content-type": "text/plain" } });
      }
      if (path === "/to-page") return Response.redirect(`${base}/page`, 302);
      if (path === "/to-metadata") return Response.redirect("http://169.254.169.254/latest/", 302);
      if (path === "/to-private-name") return Response.redirect("http://intranet.test/", 302);
      if (path.startsWith("/loop")) {
        const n = Number(path.slice(5) || 0);
        return Response.redirect(`${base}/loop${n + 1}`, 302);
      }
      if (path === "/missing") return new Response("no", { status: 404 });
      return new Response("?", { status: 500 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server?.stop(true));

const reason = async (p: Promise<unknown>) => {
  try {
    await p;
    return "read";
  } catch (err) {
    return err instanceof PageFetchError ? err.reason : `other: ${String(err)}`;
  }
};

describe("the linked page", () => {
  test("is reduced to visible text: no scripts, styles, comments or markup", async () => {
    const text = await fetchPageText(`${base}/page`, opts);
    expect(text).toContain("Bewonersavond Strijp-S");
    expect(text).toContain("Klokgebouw & GGD");
    expect(text).not.toContain("steal");
    expect(text).not.toContain("hidden");
    expect(text).not.toContain("<");
  });

  test("plain text is read as it is", async () => {
    expect(await fetchPageText(`${base}/plain`, opts)).toBe("Agenda\nWelkom door Arne");
  });

  test("a private address is refused before anything is sent", async () => {
    expect(await reason(fetchPageText(`${base}/page`, { allowPrivate: false }))).toBe(
      "blocked_address",
    );
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.1/",
      "http://100.64.0.1/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
    ])
      expect([url, await reason(fetchPageText(url, opts))]).toEqual([url, "blocked_address"]);
    // A public-looking name that resolves inward is refused the same way.
    const resolve = async () => ["192.168.1.10"];
    expect(await reason(fetchPageText("https://intranet.test/", { ...opts, resolve }))).toBe(
      "blocked_address",
    );
  });

  test("every redirect is checked again", async () => {
    expect(await fetchPageText(`${base}/to-page`, opts)).toContain("Klokgebouw");
    expect(await reason(fetchPageText(`${base}/to-metadata`, opts))).toBe("blocked_address");
    const resolve = async (host: string) => (host === "intranet.test" ? ["10.1.2.3"] : []);
    expect(await reason(fetchPageText(`${base}/to-private-name`, { ...opts, resolve }))).toBe(
      "blocked_address",
    );
  });

  test("at most three redirects", async () => {
    // loop0 -> loop1 -> loop2 -> loop3 is three; the fourth is refused.
    expect(await reason(fetchPageText(`${base}/loop`, opts))).toBe("too_many_redirects");
  });

  test("only http(s), and never credentials in the URL", async () => {
    for (const url of ["file:///etc/passwd", "ftp://x.test/", "gopher://x", "not a url"])
      expect([url, await reason(fetchPageText(url, opts))]).toEqual([url, "invalid_url"]);
    expect(await reason(fetchPageText(`http://user:pw@127.0.0.1:${server.port}/page`, opts))).toBe(
      "invalid_url",
    );
    expect(checkUrl("https://example.org/a#frag").href).toBe("https://example.org/a");
  });

  test("a body over the cap is cut at the cap, and the text is capped too", async () => {
    const text = await fetchPageText(`${base}/big`, { ...opts, limits: { maxBytes: 10_000 } });
    expect(text.length).toBeLessThanOrEqual(10_000);
    const capped = await fetchPageText(`${base}/big`, opts);
    expect(capped.length).toBeLessThanOrEqual(20_000);
  });

  test("only text/html and text/plain", async () => {
    expect(await reason(fetchPageText(`${base}/pdf`, opts))).toBe("wrong_type");
  });

  test("an error status is a soft failure", async () => {
    expect(await reason(fetchPageText(`${base}/missing`, opts))).toBe("http_status");
  });

  test("the whole read times out", async () => {
    const started = performance.now();
    expect(
      await reason(fetchPageText(`${base}/slow`, { ...opts, limits: { timeoutMs: 200 } })),
    ).toBe("timeout");
    expect(performance.now() - started).toBeLessThan(1_400);
  });
});

test("visibleText drops an unclosed script to the end of the page", () => {
  expect(visibleText("<p>Hi</p><script>evil(", "text/html")).toBe("Hi");
});
