/** One outgoing email. `tags` label the send for delivery analytics and tests. */
export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly tags?: readonly string[];
}

/** The only way code sends email. SendGrid in deployed environments, the fake in tests. */
export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

/** Records every send instead of delivering it. Tests assert on `sent`. */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  async send(msg: MailMessage): Promise<void> {
    this.sent.push(msg);
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
