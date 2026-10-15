import { expect, test } from "bun:test";
import { mailerFromSettings, ScalewayMailer, SendGridMailer } from "../src";

const base = {
  sendgridRegion: "eu" as const,
  scalewayRegion: "fr-par",
  fromEmail: "do-not-reply@example.eu",
  fromName: "dembrane",
};

test("scaleway posts one message with the token header and project", async () => {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] =
    [];
  const mailer = new ScalewayMailer({
    secretKey: "secret",
    projectId: "p-1",
    fromEmail: "do-not-reply@example.eu",
    fromName: "dembrane",
    region: "fr-par",
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        headers: init.headers as Record<string, string>,
        body: JSON.parse(String(init.body)),
      });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch,
  });
  await mailer.send({
    to: ["a@x.nl", "b@x.nl"],
    subject: "s",
    html: "<p>h</p>",
    text: "t",
    tags: ["x"],
    replyTo: { email: "r@x.nl", name: "Ra" },
  });
  expect(calls[0]?.url).toBe(
    "https://api.scaleway.com/transactional-email/v1alpha1/regions/fr-par/emails",
  );
  expect(calls[0]?.headers["x-auth-token"]).toBe("secret");
  expect(calls[0]?.body).toEqual({
    project_id: "p-1",
    from: { email: "do-not-reply@example.eu", name: "dembrane" },
    to: [{ email: "a@x.nl" }, { email: "b@x.nl" }],
    subject: "s",
    text: "t",
    html: "<p>h</p>",
    additional_headers: [{ key: "Reply-To", value: "Ra <r@x.nl>" }],
  });
});

test("a rejected scaleway send throws so the job retries", async () => {
  const mailer = new ScalewayMailer({
    secretKey: "k",
    projectId: "p",
    fromEmail: "f@x.nl",
    fromName: "f",
    region: "fr-par",
    fetch: (async () => new Response("denied", { status: 403 })) as unknown as typeof fetch,
  });
  await expect(mailer.send({ to: "a@x.nl", subject: "s", html: "h", text: "" })).rejects.toThrow(
    "scaleway mail 403",
  );
});

test("the provider setting picks the sender, and missing credentials pick none", () => {
  expect(mailerFromSettings({ ...base, provider: "sendgrid", sendgridApiKey: "k" })).toBeInstanceOf(
    SendGridMailer,
  );
  expect(
    mailerFromSettings({
      ...base,
      provider: "scaleway",
      sendgridApiKey: "k",
      scalewaySecretKey: "s",
      scalewayProjectId: "p",
    }),
  ).toBeInstanceOf(ScalewayMailer);
  expect(mailerFromSettings({ ...base, provider: "scaleway", sendgridApiKey: "k" })).toBeNull();
  expect(mailerFromSettings({ ...base, provider: "sendgrid" })).toBeNull();
});
