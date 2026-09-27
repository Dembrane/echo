/** One outgoing email, already rendered. Multipart: the text part goes first, then HTML. */
export interface MailMessage {
  readonly to: string | readonly string[];
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  /** Free-form labels for delivery analytics (SendGrid categories). */
  readonly tags?: readonly string[];
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
