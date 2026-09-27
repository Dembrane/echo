import type { Mailer, MailMessage } from "./mailer";

export interface SendGridOptions {
  readonly apiKey: string;
  /** "eu" keeps recipient data and content in EU data centres; the key must be an EU subuser key. */
  readonly region: "eu" | "global";
  readonly fromEmail: string;
  readonly fromName: string;
  readonly fetch?: typeof fetch;
}

export class SendGridError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SendGridError";
  }
}

/**
 * SendGrid v3 mail send. Throws on a refused send so the caller (usually a job) retries
 * or records the failure; nothing is swallowed here.
 */
export class SendGridMailer implements Mailer {
  private readonly endpoint: string;
  constructor(private readonly opts: SendGridOptions) {
    this.endpoint =
      opts.region === "eu"
        ? "https://api.eu.sendgrid.com/v3/mail/send"
        : "https://api.sendgrid.com/v3/mail/send";
  }

  async send(msg: MailMessage): Promise<void> {
    const res = await (this.opts.fetch ?? fetch)(this.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.opts.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: msg.to }] }],
        from: { email: this.opts.fromEmail, name: this.opts.fromName },
        subject: msg.subject,
        // SendGrid wants text/plain before text/html for multipart/alternative.
        content: [
          { type: "text/plain", value: msg.text },
          { type: "text/html", value: msg.html },
        ],
        ...(msg.tags?.length && { categories: msg.tags.slice(0, 10) }),
      }),
    });
    if (res.status >= 400) {
      throw new SendGridError(
        `SendGrid refused the send: ${res.status} ${(await res.text()).slice(0, 300)}`,
        res.status,
      );
    }
  }
}
