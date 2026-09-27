import type { Mailer, MailMessage } from "./mailer";

/** Keeps sent messages in memory: tests read `sent`, local runs log instead of emailing. */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];

  async send(msg: MailMessage): Promise<void> {
    this.sent.push(msg);
  }
}
