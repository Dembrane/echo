import { expect, test } from "bun:test";
import { MemoryMailer, SendGridMailer } from "../src";

test("sendgrid: text before html, EU host, categories from tags", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const mailer = new SendGridMailer({
    apiKey: "k",
    fromEmail: "no-reply@dembrane.com",
    fromName: "dembrane",
    region: "eu",
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch,
  });
  await mailer.send({ to: "a@b.co", subject: "s", html: "<p>h</p>", text: "h", tags: ["invite"] });
  expect(calls[0]?.url).toBe("https://api.eu.sendgrid.com/v3/mail/send");
  const body = JSON.parse(String(calls[0]?.init.body));
  expect(body.content.map((c: { type: string }) => c.type)).toEqual(["text/plain", "text/html"]);
  expect(body.categories).toEqual(["invite"]);
});

test("sendgrid: a refused send throws so the job retries", async () => {
  const mailer = new SendGridMailer({
    apiKey: "k",
    fromEmail: "f@d.com",
    fromName: "d",
    region: "global",
    fetch: (async () => new Response("bad", { status: 401 })) as unknown as typeof fetch,
  });
  await expect(mailer.send({ to: "a@b.co", subject: "s", html: "h", text: "h" })).rejects.toThrow(
    "sendgrid 401",
  );
});

test("memory mailer records what was sent", async () => {
  const m = new MemoryMailer();
  await m.send({ to: "a@b.co", subject: "s", html: "h", text: "t" });
  expect(m.sent).toHaveLength(1);
});
