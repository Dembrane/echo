import type { Mailer, MailMessage } from "./mailer";

export interface SendGridOptions {
  readonly apiKey: string;
  readonly fromEmail: string;
  readonly fromName: string;
  /** "eu" keeps recipient data and content in EU data centres; the key must belong to an EU subuser. */
  readonly region: "eu" | "global";
  /** Injected so tests can assert the request without the network. */
  readonly fetch?: typeof fetch;
}

/** SendGrid's v3 mail API over plain fetch: no SDK dependency. */
export class SendGridMailer implements Mailer {
  private readonly fetcher: typeof fetch;
  constructor(private readonly opts: SendGridOptions) {
    this.fetcher = opts.fetch ?? fetch;
  }

  async send(msg: MailMessage): Promise<void> {
    const host = this.opts.region === "eu" ? "api.eu.sendgrid.com" : "api.sendgrid.com";
    const to = (typeof msg.to === "string" ? [msg.to] : msg.to).map((email) => ({ email }));
    const res = await this.fetcher(`https://${host}/v3/mail/send`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.opts.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to }],
        from: { email: this.opts.fromEmail, name: this.opts.fromName },
        subject: msg.subject,
        content: [
          ...(msg.text ? [{ type: "text/plain", value: msg.text }] : []),
          { type: "text/html", value: msg.html },
        ],
        ...(msg.tags?.length && { categories: msg.tags.slice(0, 10) }),
      }),
    });
    if (res.status >= 400) {
      throw new Error(`sendgrid ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
  }
}
