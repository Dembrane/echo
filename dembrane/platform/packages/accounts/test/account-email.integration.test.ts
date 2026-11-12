import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import * as K from "../src/contract";
import type { GmailReader, GmailThread } from "../src/gmail";
import { accountsRoutes } from "../src/routes";
import { admin, call, dropDatabase, type World, world } from "./helpers";

// The account card's email: staff and sam's key read it, nobody else; it is matched on the
// organisation's members and read live from the mailboxes.
const run = admin ? describe : describe.skip;
const DB = `accounts_email_${process.pid}`;

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const thread = (id: string, from: string, text: string): GmailThread => ({
  id,
  messages: [
    {
      id: `${id}-1`,
      threadId: id,
      internalDate: String(Date.parse("2026-11-03T10:00:00Z")),
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: from },
          { name: "To", value: "jorim@dembrane.com" },
          { name: "Subject", value: "Offerte" },
          { name: "Message-ID", value: `<${id}@mail>` },
        ],
        body: { data: b64(text) },
      },
    },
  ],
});

class FakeGmail implements GmailReader {
  mailboxes = ["jorim@dembrane.com", "evelien@dembrane.com"];
  searches: { mailbox: string; q: string }[] = [];
  failing = new Set<string>();
  async searchThreads(mailbox: string, q: string) {
    this.searches.push({ mailbox, q });
    if (this.failing.has(mailbox)) throw new Error("401");
    return mailbox === "jorim@dembrane.com" ? ["t1", "t2"] : [];
  }
  async thread(_mailbox: string, id: string) {
    return id === "t1"
      ? thread("t1", "Admin <admin@example.test>", "Wanneer kunnen we tekenen?\n\n> eerder")
      : thread("t2", "someone@elsewhere.test", "unrelated");
  }
}

run("the account's email", () => {
  setDefaultTimeout(60_000);
  let w: World;
  beforeAll(async () => {
    w = await world(DB, accountsRoutes);
  });
  afterAll(async () => {
    await w?.close();
    await dropDatabase(DB);
  });
  const path = () => `/api/v2/admin/accounts/${w.orgId}/email`;
  const setGmail = (g: GmailReader | null) => {
    (w.deps as { gmail?: GmailReader | null }).gmail = g;
  };

  test("without a mailbox connected, it says so", async () => {
    setGmail(null);
    const r = await call(w, "GET", path(), "staff");
    expect(r.status).toBe(503);
  });

  test("customers never read it", async () => {
    setGmail(new FakeGmail());
    expect((await call(w, "GET", path(), "admin")).status).toBe(403);
  });

  test("staff and a staff key read the merged threads with the organisation in them", async () => {
    const g = new FakeGmail();
    setGmail(g);
    for (const who of ["staff", "key"] as const) {
      const r = await call(w, "GET", `${path()}?refresh=true`, who);
      expect(r.status).toBe(200);
      const v = K.AccountEmail.parse(r.data);
      expect(v.matched.domains).toEqual(["example.test"]);
      expect(v.threads.map((t) => t.subject)).toEqual(["Offerte"]);
      expect(v.threads[0]?.messages[0]?.text).toBe("Wanneer kunnen we tekenen?");
      expect(v.threads[0]?.messages[0]?.from.side).toBe("organisation");
      expect(v.threads[0]?.gmail[0]?.url).toBe(
        "https://mail.google.com/mail/u/jorim%40dembrane.com/#all/t1",
      );
    }
    expect(g.searches[0]?.q).toContain("from:example.test");
  });

  test("a mailbox that cannot be read is named, and the rest still shows", async () => {
    const g = new FakeGmail();
    g.failing.add("evelien@dembrane.com");
    setGmail(g);
    const v = K.AccountEmail.parse((await call(w, "GET", `${path()}?refresh=true`, "staff")).data);
    expect(v.mailboxes).toEqual([
      { mailbox: "jorim@dembrane.com", ok: true },
      { mailbox: "evelien@dembrane.com", ok: false },
    ]);
    expect(v.threads).toHaveLength(1);
  });

  test("a full read is served from memory for a few minutes", async () => {
    const g = new FakeGmail();
    setGmail(g);
    await call(w, "GET", path(), "staff");
    const n = g.searches.length;
    await call(w, "GET", path(), "staff");
    expect(g.searches.length).toBe(n);
    await call(w, "GET", `${path()}?refresh=true`, "staff");
    expect(g.searches.length).toBe(n + g.mailboxes.length);
  });
});
