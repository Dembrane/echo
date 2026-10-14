/** One outgoing email, already rendered. Multipart: the text part goes first, then HTML. */
export interface MailMessage {
  readonly to: string | readonly string[];
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  /** Free-form labels for delivery analytics (SendGrid categories). */
  readonly tags?: readonly string[];
  /** Where a reply goes, when not to the sender: the person at dembrane who owns the account. */
  readonly replyTo?: { readonly email: string; readonly name?: string | null };
}

/**
 * The only way the platform sends email. Implementations throw on a failed send so the
 * job that called them is retried by the queue.
 */
export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

/** Records messages instead of sending them: tests, local development and parity runs. */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  async send(msg: MailMessage): Promise<void> {
    this.sent.push(msg);
  }
}

/**
 * Writes each message, text part included, to the log instead of sending it: local
 * development, where the sign-in codes and links in it are the only way in. Never for an
 * environment whose logs are shared, since those codes sign a person in.
 */
export class LogMailer implements Mailer {
  constructor(private readonly log: (fields: Record<string, unknown>, message: string) => void) {}
  async send(msg: MailMessage): Promise<void> {
    this.log({ to: msg.to, subject: msg.subject, tags: msg.tags, text: msg.text }, "mail not sent");
  }
}

/** Escapes text for HTML bodies, the way the old Jinja templates autoescaped every value. */
export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&#34;")
    .replaceAll("'", "&#39;");
}
