import { describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { gmailUrl, mergeThreads, searchFor } from "../src/account-email";
import { mailIdentity } from "../src/email-domains";
import {
  delegationAssertion,
  GMAIL_SCOPE,
  type GmailMessage,
  gmailFromConfig,
  serviceAccountGmail,
} from "../src/gmail";
import { addresses, htmlToText, messageText, newText } from "../src/mail-text";

const b64 = (s: string) => Buffer.from(s).toString("base64url");

function msg(o: {
  id: string;
  thread: string;
  mid: string;
  from: string;
  to?: string;
  at: string;
  subject?: string;
  text?: string;
  html?: string;
  draft?: boolean;
}): GmailMessage {
  const headers = [
    { name: "From", value: o.from },
    { name: "To", value: o.to ?? "jorim@dembrane.com" },
    { name: "Subject", value: o.subject ?? "Re: Pilot in maart" },
    { name: "Message-ID", value: o.mid },
  ];
  const parts = [
    ...(o.text !== undefined ? [{ mimeType: "text/plain", body: { data: b64(o.text) } }] : []),
    ...(o.html !== undefined ? [{ mimeType: "text/html", body: { data: b64(o.html) } }] : []),
  ];
  return {
    id: o.id,
    threadId: o.thread,
    internalDate: String(new Date(o.at).getTime()),
    labelIds: o.draft ? ["DRAFT"] : ["INBOX"],
    payload: { mimeType: "multipart/alternative", headers, parts },
  };
}

describe("quoted history", () => {
  test("cuts an English Gmail reply at its attribution line", () => {
    const raw =
      "Sounds good, Tuesday works.\n\nOn Tue, 3 Nov 2026 at 10:00, Jorim <jorim@dembrane.com> wrote:\n> Shall we meet Tuesday?\n> Jorim";
    expect(newText(raw)).toBe("Sounds good, Tuesday works.");
  });

  test("cuts an attribution that wraps onto a second line", () => {
    const raw =
      "Prima!\n\nOn Tue, 3 Nov 2026 at 10:00, Jorim Theuns <\njorim@dembrane.com> wrote:\n\n> earlier";
    expect(newText(raw)).toBe("Prima!");
  });

  test("cuts a Dutch reply and drops the phone footer", () => {
    const raw =
      "Dank je, we tekenen vandaag.\n\nVerzonden vanaf mijn iPhone\n\nOp 3 nov 2026 om 10:00 heeft Eve <evelien@dembrane.com> het volgende geschreven:\n\nOp di 3 nov. 2026 schreef Eve:";
    expect(newText(raw)).toBe("Dank je, we tekenen vandaag.");
  });

  test("cuts an Outlook header block and a signature", () => {
    const outlook =
      "Zie bijlage.\n\n________________________________\nVan: Ann de Vries <ann@gemeente.nl>\nVerzonden: dinsdag 3 november 2026 10:00\nAan: Eve\nOnderwerp: offerte";
    expect(newText(outlook)).toBe("Zie bijlage.");
    expect(newText("Thanks!\n-- \nAnn de Vries\nGemeente")).toBe("Thanks!");
  });

  test("HTML: the gmail_quote container and everything after it is history", () => {
    const html =
      '<div dir="ltr">Yes, <b>Tuesday</b> &amp; Wednesday.<br>Ann</div><div class="gmail_quote"><div>On Mon wrote:</div><blockquote>old</blockquote></div>';
    expect(htmlToText(html).trim()).toBe("Yes, Tuesday & Wednesday.\nAnn");
  });

  test("HTML: scripts, styles and every tag go; escaped markup stays as text", () => {
    const html =
      "<style>p{color:red}</style><p>Hi<script>alert(1)</script> there</p><SCRIPT>x</SCRIPT>&lt;b&gt; ok<br/><ul><li>one</li></ul><p unclosed";
    expect(htmlToText(html)).toBe("\nHi there\n<b> ok\n\n- one\n");
  });

  test("prefers text/plain, falls back to HTML, never returns nothing for a pure quote", () => {
    const both = msg({
      id: "1",
      thread: "t",
      mid: "<a@x>",
      from: "ann@gemeente.nl",
      at: "2026-11-03T10:00:00Z",
      text: "plain wins",
      html: "<p>html loses</p>",
    });
    expect(messageText(both.payload)).toBe("plain wins");
    const onlyQuote = msg({
      id: "2",
      thread: "t",
      mid: "<b@x>",
      from: "ann@gemeente.nl",
      at: "2026-11-03T10:00:00Z",
      text: "> only a quote",
    });
    expect(messageText(onlyQuote.payload)).toBe("> only a quote");
  });

  test("reads names and addresses from a header", () => {
    expect(addresses('"de Vries, Ann" <Ann@Gemeente.nl>, bob@x.nl')).toEqual([
      { name: "de Vries, Ann", email: "ann@gemeente.nl" },
      { name: null, email: "bob@x.nl" },
    ]);
  });
});

describe("matching an organisation", () => {
  test("own domains count, public providers only as the exact address, never dembrane", () => {
    expect(
      mailIdentity(["ann@gemeente.nl", "bob@gemeente.nl", "cas@gmail.com", "jorim@dembrane.com"]),
    ).toEqual({ domains: ["gemeente.nl"], addresses: ["cas@gmail.com"] });
  });

  test("an organisation with no known addresses has no search, so no email", () => {
    expect(searchFor({ domains: [], addresses: [] })).toBeNull();
    expect(searchFor({ domains: ["gemeente.nl"], addresses: [] })).toBe(
      "{from:gemeente.nl to:gemeente.nl cc:gemeente.nl} newer_than:2y -in:chats",
    );
  });
});

describe("merging threads", () => {
  const identity = { domains: ["gemeente.nl"], addresses: [] };

  test("one conversation in two mailboxes is one thread, each message once", () => {
    const first = {
      mid: "<1@gemeente.nl>",
      from: "Ann <ann@gemeente.nl>",
      to: "jorim@dembrane.com, evelien@dembrane.com",
      at: "2026-11-02T09:00:00Z",
      subject: "Pilot in maart",
      text: "Kunnen we in maart starten?",
    };
    const reply = {
      mid: "<2@dembrane.com>",
      from: "Eve <evelien@dembrane.com>",
      to: "ann@gemeente.nl",
      at: "2026-11-02T11:00:00Z",
      text: "Ja, graag.\n\nOp 2 nov 2026 schreef Ann <ann@gemeente.nl>:\n> Kunnen we in maart starten?",
    };
    const threads = mergeThreads(
      [
        {
          mailbox: "jorim@dembrane.com",
          messages: [
            msg({ id: "j1", thread: "jt", ...first }),
            msg({ id: "j2", thread: "jt", ...reply }),
          ],
        },
        {
          mailbox: "evelien@dembrane.com",
          messages: [
            msg({ id: "e1", thread: "et", ...first }),
            msg({ id: "e2", thread: "et", ...reply }),
            msg({
              id: "e3",
              thread: "et",
              mid: "<3@x>",
              from: "evelien@dembrane.com",
              at: "2026-11-02T12:00:00Z",
              text: "unsent",
              draft: true,
            }),
          ],
        },
      ],
      identity,
    );
    expect(threads).toHaveLength(1);
    const t = threads[0];
    expect(t?.subject).toBe("Pilot in maart");
    expect(t?.messages.map((m) => [m.from.side, m.text])).toEqual([
      ["organisation", "Kunnen we in maart starten?"],
      ["dembrane", "Ja, graag."],
    ]);
    expect(t?.messages[0]?.mailboxes).toEqual(["evelien@dembrane.com", "jorim@dembrane.com"]);
    expect(t?.gmail).toEqual([
      { mailbox: "evelien@dembrane.com", url: gmailUrl("evelien@dembrane.com", "et") },
      { mailbox: "jorim@dembrane.com", url: gmailUrl("jorim@dembrane.com", "jt") },
    ]);
    expect(t?.last_message_at).toBe("2026-11-02T11:00:00.000Z");
  });

  test("a thread with nobody of the organisation in it is left out", () => {
    const threads = mergeThreads(
      [
        {
          mailbox: "jorim@dembrane.com",
          messages: [
            msg({
              id: "x",
              thread: "xt",
              mid: "<x@y>",
              from: "news@notgemeente.nl",
              at: "2026-11-01T00:00:00Z",
              text: "newsletter",
            }),
          ],
        },
      ],
      identity,
    );
    expect(threads).toEqual([]);
  });
});

describe("the service account", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = {
    client_email: "echo-mail@dembrane.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };

  test("asks for gmail.readonly as the mailbox, signed with the key", () => {
    const jwt = delegationAssertion(key, "jorim@dembrane.com", new Date("2026-11-04T12:00:00Z"));
    const [h, c, s] = jwt.split(".") as [string, string, string];
    const claims = JSON.parse(Buffer.from(c, "base64url").toString());
    expect(claims).toMatchObject({
      iss: key.client_email,
      sub: "jorim@dembrane.com",
      scope: GMAIL_SCOPE,
      aud: "https://oauth2.googleapis.com/token",
    });
    expect(claims.exp - claims.iat).toBe(3600);
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${c}`);
    expect(v.verify(publicKey, Buffer.from(s, "base64url"))).toBe(true);
  });

  test("swaps the assertion for a token once per mailbox, then searches", async () => {
    const calls: string[] = [];
    const fake = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push(u.split("?")[0] as string);
      if (u.startsWith("https://oauth2.googleapis.com/token"))
        return Response.json({ access_token: "tok", expires_in: 3600 });
      expect((init?.headers as Record<string, string> | undefined)?.authorization).toBe(
        "Bearer tok",
      );
      return Response.json({ threads: [{ id: "a" }, { id: "b" }] });
    }) as typeof fetch;
    const g = serviceAccountGmail({ key, mailboxes: ["jorim@dembrane.com"], fetch: fake });
    expect(await g.searchThreads("jorim@dembrane.com", "from:x.nl", 5)).toEqual(["a", "b"]);
    await g.searchThreads("jorim@dembrane.com", "from:x.nl", 5);
    expect(calls.filter((c) => c.includes("oauth2"))).toHaveLength(1);
    expect(calls[1]).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/jorim%40dembrane.com/threads",
    );
  });

  test("is off until both settings are there", () => {
    expect(gmailFromConfig(undefined, "jorim@dembrane.com")).toBeNull();
    expect(gmailFromConfig(JSON.stringify(key), "")).toBeNull();
    expect(
      gmailFromConfig(JSON.stringify(key), " Jorim@dembrane.com, evelien@dembrane.com")?.mailboxes,
    ).toEqual(["jorim@dembrane.com", "evelien@dembrane.com"]);
  });
});
