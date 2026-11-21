/**
 * The PostHog distinct id of a host: their email, trimmed and lowercased, as the browser
 * identifies them. Without an email the Directus user id, which the browser aliases onto
 * the same person once the host signs in.
 */
export function hostDistinctId(email: string | null | undefined, directusUserId: string): string {
  return email?.trim().toLowerCase() || directusUserId;
}
