import type { Mailer, MailMessage } from "./mailer";

export interface ScalewayMailOptions {
  /** Scaleway API secret key, sent as X-Auth-Token. */
  readonly secretKey: string;
  readonly projectId: string;
  readonly fromEmail: string;
  readonly fromName: string;
  /** Region of Transactional Email, such as fr-par. */
  readonly region: string;
  /** Injected so tests can assert the request without the network. */
  readonly fetch?: typeof fetch;
}

/**
 * Scaleway Transactional Email over plain fetch. Tags have no counterpart there and are
 * dropped; a reply-to address travels as a header.
 */
export class ScalewayMailer implements Mailer {
  private readonly fetcher: typeof fetch;
  constructor(private readonly opts: ScalewayMailOptions) {
    this.fetcher = opts.fetch ?? fetch;
  }

  async send(msg: MailMessage): Promise<void> {
    const to = (typeof msg.to === "string" ? [msg.to] : msg.to).map((email) => ({ email }));
    const replyTo = msg.replyTo
      ? msg.replyTo.name
        ? `${msg.replyTo.name.replace(/[<>"\r\n]/g, "")} <${msg.replyTo.email}>`
        : msg.replyTo.email
      : null;
    const res = await this.fetcher(
      `https://api.scaleway.com/transactional-email/v1alpha1/regions/${this.opts.region}/emails`,
      {
        method: "POST",
        headers: { "x-auth-token": this.opts.secretKey, "content-type": "application/json" },
        body: JSON.stringify({
          project_id: this.opts.projectId,
          from: { email: this.opts.fromEmail, name: this.opts.fromName },
          to,
          subject: msg.subject,
          text: msg.text,
          html: msg.html,
          ...(replyTo && { additional_headers: [{ key: "Reply-To", value: replyTo }] }),
        }),
      },
    );
    if (res.status >= 400) {
      throw new Error(`scaleway mail ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
  }
}
