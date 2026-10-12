import { describe, expect, test } from "bun:test";
import { httpMiro, MiroError, type MiroItem, miroBoardId } from "../src/miro";
import { contentHash, htmlToText, readingOrder, segments } from "../src/render";
import { readState, signState, tokenSealer } from "../src/seal";

const KEY = Buffer.alloc(32, 7).toString("base64");
const item = (id: string, x: number, y: number, text = id, type = "sticky_note"): MiroItem => ({
  id,
  type,
  text,
  x,
  y,
  width: 100,
  height: 100,
});

describe("token sealing", () => {
  test("opens what it sealed, and never stores the token in clear", () => {
    const s = tokenSealer(KEY);
    const sealed = s.seal("secret-token");
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain("secret-token");
    expect(s.open(sealed)).toBe("secret-token");
    expect(s.seal("secret-token")).not.toBe(sealed);
  });

  test("a tampered value or another key does not open", () => {
    const sealed = tokenSealer(KEY).seal("t");
    const [v, iv, tag, body] = sealed.split(".") as [string, string, string, string];
    const bytes = Buffer.from(body, "base64url");
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    const flipped = [v, iv, tag, bytes.toString("base64url")].join(".");
    expect(() => tokenSealer(KEY).open(flipped)).toThrow();
    expect(() => tokenSealer(Buffer.alloc(32, 8).toString("base64")).open(sealed)).toThrow();
  });

  test("refuses a key that is not 32 bytes", () => {
    expect(() => tokenSealer(Buffer.alloc(16).toString("base64"))).toThrow();
  });
});

describe("oauth state", () => {
  const now = new Date("2026-10-11T12:00:00Z");
  const s = { user: "u1", project: "p1", provider: "miro" };

  test("reads back what it signed within ten minutes", () => {
    const raw = signState("secret", s, now);
    expect(readState("secret", raw, new Date(now.getTime() + 9 * 60_000))).toMatchObject(s);
    expect(readState("secret", raw, new Date(now.getTime() + 11 * 60_000))).toBeNull();
  });

  test("a changed body or another secret is refused", () => {
    const raw = signState("secret", s, now);
    const [, sig] = raw.split(".");
    const forged = `${Buffer.from(JSON.stringify({ ...s, user: "u2", exp: 9e9, nonce: "x" })).toString("base64url")}.${sig}`;
    expect(readState("secret", forged, now)).toBeNull();
    expect(readState("other", raw, now)).toBeNull();
    expect(readState("secret", "garbage", now)).toBeNull();
  });
});

describe("frame text", () => {
  test("keeps line breaks and list items, drops markup and decodes entities", () => {
    expect(htmlToText("<p>Bus stop &amp; <strong>bike</strong> lane</p><p>2nd&nbsp;line</p>")).toBe(
      "Bus stop & bike lane\n2nd line",
    );
    expect(htmlToText("<ul><li>one</li><li>two</li></ul>")).toBe("- one\n- two");
    expect(htmlToText("a<br/>b &#233; &#x1F600;")).toBe("a\nb é 😀");
    expect(htmlToText("<scr<b>ipt>alert(1)</script>")).toBe("alert(1)");
    expect(htmlToText("1 &lt; 2")).toBe("1 < 2");
  });

  test("reads rows top to bottom and left to right, tolerating uneven heights", () => {
    const order = readingOrder([
      item("row2-left", 0, 300),
      item("row1-right", 400, 10),
      item("row1-left", 0, 0),
      item("row1-mid", 200, 30),
    ]).map((i) => i.id);
    expect(order).toEqual(["row1-left", "row1-mid", "row1-right", "row2-left"]);
  });

  test("skips connectors and items without words", () => {
    const segs = segments([
      item("a", 0, 0, "<p>Hello</p>"),
      item("c", 50, 0, "", "connector"),
      item("img", 100, 0, "", "image"),
    ]);
    expect(segs).toEqual([{ itemId: "a", text: "Hello" }]);
  });

  test("the hash changes with the words and the order, not with positions alone", () => {
    const a = segments([item("1", 0, 0, "x"), item("2", 200, 0, "y")]);
    const moved = segments([item("1", 0, 5, "x"), item("2", 210, 0, "y")]);
    const swapped = segments([item("1", 200, 0, "x"), item("2", 0, 0, "y")]);
    expect(contentHash("t", a)).toBe(contentHash("t", moved));
    expect(contentHash("t", a)).not.toBe(contentHash("t", swapped));
    expect(contentHash("t", a)).not.toBe(contentHash("u", a));
  });
});

describe("miro client", () => {
  test("board ids from links and bare ids", () => {
    expect(miroBoardId("https://miro.com/app/board/uXjVKabc123=/?share_link_id=1")).toBe(
      "uXjVKabc123=",
    );
    expect(miroBoardId("uXjVKabc123=")).toBe("uXjVKabc123=");
    expect(miroBoardId("https://evil.test/../x")).toBeNull();
    expect(miroBoardId("https://evil.test/miro.com/app/board/uXjVKabc123=/")).toBeNull();
    expect(miroBoardId("https://miro.com.evil.test/app/board/uXjVKabc123=/")).toBeNull();
  });

  test("follows cursors for a frame's items and reads titles and content", async () => {
    const calls: string[] = [];
    const miro = httpMiro({
      clientId: "id",
      clientSecret: "sec",
      fetch: async (url) => {
        calls.push(url);
        const second = url.includes("cursor=c2");
        const body = second
          ? { data: [{ id: "3", type: "card", data: { title: "T", description: "D" } }] }
          : {
              data: [
                {
                  id: "1",
                  type: "sticky_note",
                  data: { content: "<p>a</p>" },
                  position: { x: 1, y: 2 },
                },
                {
                  id: "2",
                  type: "text",
                  data: { content: "b" },
                  geometry: { width: 5, height: 6 },
                },
              ],
              cursor: "c2",
            };
        return new Response(JSON.stringify(body), { status: 200 });
      },
    });
    const items = await miro.frameItems("tok", "B", "F");
    expect(items.map((i) => [i.id, i.text])).toEqual([
      ["1", "<p>a</p>"],
      ["2", "b"],
      ["3", "T\nD"],
    ]);
    expect(calls[0]).toBe("https://api.miro.com/v2/boards/B/items?parent_item_id=F&limit=50");
    expect(calls[1]).toContain("cursor=c2");
  });

  test("the code exchange sends the client credentials and reads the team", async () => {
    let seen = "";
    const miro = httpMiro({
      clientId: "id",
      clientSecret: "sec",
      fetch: async (url, init) => {
        seen = `${init?.method} ${url}`;
        return new Response(
          JSON.stringify({
            access_token: "a",
            refresh_token: "r",
            expires_in: 3599,
            scope: "boards:read",
            team_id: "T1",
            user_id: 42,
          }),
        );
      },
    });
    const t = await miro.exchange("code", "https://api.test/cb");
    expect(t).toEqual({
      accessToken: "a",
      refreshToken: "r",
      expiresIn: 3599,
      scope: "boards:read",
      teamId: "T1",
      userId: "42",
    });
    expect(seen).toContain("POST https://api.miro.com/v1/oauth/token?");
    expect(seen).toContain("grant_type=authorization_code");
    expect(seen).toContain("client_secret=sec");
    expect(seen).toContain("redirect_uri=https%3A%2F%2Fapi.test%2Fcb");
  });

  test("an error status throws MiroError; a missing board reads as null", async () => {
    const miro = httpMiro({
      clientId: "id",
      clientSecret: "s",
      fetch: async (url) =>
        new Response("nope", { status: url.includes("/v2/boards/gone") ? 404 : 429 }),
    });
    expect(await miro.board("t", "gone")).toBeNull();
    await expect(miro.boards("t", null)).rejects.toBeInstanceOf(MiroError);
  });
});
