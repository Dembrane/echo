/**
 * The shape registration accepts for an email address, mirrored from
 * platform/packages/account/src/email.ts. The server drops an address it refuses without
 * saying so (it never tells whether an address is registered), so the form must refuse
 * the same addresses first. Tests on both sides fail when the two patterns differ.
 */
export const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/** True when registration would accept the address: trimmed and lowercased, as it is stored. */
export function isValidEmail(email: string): boolean {
	return EMAIL_RE.test(email.trim().toLowerCase());
}
