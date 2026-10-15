import type { Mailer } from "./mailer";
import { ScalewayMailer } from "./scaleway";
import { SendGridMailer } from "./sendgrid";

/** The `mail` section of the platform config, as far as the sender choice reads it. */
export interface MailSettings {
  readonly provider: "sendgrid" | "scaleway";
  readonly sendgridApiKey?: string | undefined;
  readonly sendgridRegion: "eu" | "global";
  readonly scalewaySecretKey?: string | undefined;
  readonly scalewayProjectId?: string | undefined;
  readonly scalewayRegion: string;
  readonly fromEmail: string;
  readonly fromName: string;
}

/** The configured sender, or null when its credentials are not set (local, preview). */
export function mailerFromSettings(s: MailSettings, fetcher?: typeof fetch): Mailer | null {
  if (s.provider === "scaleway") {
    if (!s.scalewaySecretKey || !s.scalewayProjectId) return null;
    return new ScalewayMailer({
      secretKey: s.scalewaySecretKey,
      projectId: s.scalewayProjectId,
      fromEmail: s.fromEmail,
      fromName: s.fromName,
      region: s.scalewayRegion,
      ...(fetcher && { fetch: fetcher }),
    });
  }
  if (!s.sendgridApiKey) return null;
  return new SendGridMailer({
    apiKey: s.sendgridApiKey,
    fromEmail: s.fromEmail,
    fromName: s.fromName,
    region: s.sendgridRegion,
    ...(fetcher && { fetch: fetcher }),
  });
}

/** Names the setting a deployment is missing, for the log line that says mail is not sent. */
export const missingMailKey = (s: Pick<MailSettings, "provider">) =>
  s.provider === "scaleway"
    ? "SCALEWAY_MAIL_SECRET_KEY or SCALEWAY_MAIL_PROJECT_ID"
    : "SENDGRID_API_KEY";
