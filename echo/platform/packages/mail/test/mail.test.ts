import { expect, test } from "bun:test";
import { escapeHtml, MemoryMailer, SendGridError, SendGridMailer } from "../src";

const msg = { to: "a@example.com", subject: "Hi", html: "<p>x</p>", text: "x", tags: ["t"] };

test("the fake records sends", async () => {
  const m = new MemoryMailer();
  await m.send(msg);
  expect(m.sent).toEqual([msg]);
});

test("sendgrid posts text before html to the EU endpoint", async () => {
  let seen: { url: string; body: Record<string, unknown> } | undefined;
  const mailer = new SendGridMailer({
    apiKey: "k",
    region: "eu",
    fromEmail: "do-not-reply@dembrane.com",
    fromName: "dembrane",
    fetch: (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(String(init.body)) };
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch,
  });
  await mailer.send(msg);
  expect(seen?.url).toBe("https://api.eu.sendgrid.com/v3/mail/send");
  expect(((seen?.body.content ?? []) as { type: string }[]).map((c) => c.type)).toEqual([
    "text/plain",
    "text/html",
  ]);
  expect(seen?.body.categories).toEqual(["t"]);
});

test("a refused send throws", async () => {
  const mailer = new SendGridMailer({
    apiKey: "k",
    region: "global",
    fromEmail: "f@x",
    fromName: "f",
    fetch: (async () => new Response("bad", { status: 401 })) as unknown as typeof fetch,
  });
  await expect(mailer.send(msg)).rejects.toBeInstanceOf(SendGridError);
});

test("html escaping matches Jinja autoescape", () => {
  expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
    "&lt;a href=&#34;x&#34;&gt;&#39;&amp;&#39;&lt;/a&gt;",
  );
});
