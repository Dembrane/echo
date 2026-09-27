/** One outgoing email. `text` is always sent alongside `html`: it lowers spam scores and suits text-only clients. */
export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  /** Delivery categories, for filtering in the provider's activity feed. */
  readonly tags?: readonly string[];
}

/** Sends email. Throws on failure so the job that called it retries. */
export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}
