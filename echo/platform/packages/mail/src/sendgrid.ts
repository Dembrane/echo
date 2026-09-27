import type { Mailer, MailMessage } from "./mailer";

export interface SendGridOptions {
  readonly apiKey: string;
  readonly fromEmail: string;
  readonly fromName: string;
  /** "eu" keeps recipient data in the EU; the key must belong to an EU subuser. */
  readonly region: "global" | "eu";
  readonly fetch?: typeof fetch;
}

/** SendGrid's v3 API over fetch: no SDK, one request per message. */
export class SendGridMailer implements Mailer {
  constructor(private readonly opts: SendGridOptions) {}

  async send(msg: MailMessage): Promise<void> {
    const host = this.opts.region === "eu" ? "api.eu.sendgrid.com" : "api.sendgrid.com";
    const res = await (this.opts.fetch ?? fetch)(`https://${host}/v3/mail/send`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.opts.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: msg.to }] }],
        from: { email: this.opts.fromEmail, name: this.opts.fromName },
        subject: msg.subject,
        // SendGrid requires text/plain before text/html.
        content: [
          { type: "text/plain", value: msg.text },
          { type: "text/html", value: msg.html },
        ],
        ...(msg.tags?.length && { categories: [...msg.tags] }),
      }),
    });
    if (!res.ok) {
      throw new Error(`sendgrid ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
  }
}
