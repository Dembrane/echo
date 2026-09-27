import { expect, test } from "bun:test";
import { MemoryMailer, SendGridMailer } from "../src";

test("sendgrid posts one multipart message to the regional host", async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const mailer = new SendGridMailer({
    apiKey: "k",
    fromEmail: "do-not-reply@dembrane.com",
    fromName: "dembrane",
    region: "eu",
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch,
  });
  await mailer.send({ to: ["a@x.nl", "b@x.nl"], subject: "s", html: "<p>h</p>", text: "t" });
  expect(calls[0]?.url).toBe("https://api.eu.sendgrid.com/v3/mail/send");
  expect(calls[0]?.body).toMatchObject({
    personalizations: [{ to: [{ email: "a@x.nl" }, { email: "b@x.nl" }] }],
    content: [
      { type: "text/plain", value: "t" },
      { type: "text/html", value: "<p>h</p>" },
    ],
  });
});

test("a rejected send throws so the job retries", async () => {
  const mailer = new SendGridMailer({
    apiKey: "k",
    fromEmail: "f@x.nl",
    fromName: "f",
    region: "global",
    fetch: (async () => new Response("bad key", { status: 401 })) as unknown as typeof fetch,
  });
  await expect(mailer.send({ to: "a@x.nl", subject: "s", html: "h", text: "" })).rejects.toThrow(
    "sendgrid 401",
  );
});

test("the memory mailer records what would have been sent", async () => {
  const mailer = new MemoryMailer();
  await mailer.send({ to: "a@x.nl", subject: "s", html: "h", text: "t" });
  expect(mailer.sent).toHaveLength(1);
});
