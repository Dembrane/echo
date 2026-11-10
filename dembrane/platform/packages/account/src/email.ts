/**
 * The shape an email address must have before registration looks it up. Domain labels
 * exclude "." so the pattern cannot backtrack. The registration form applies the same rule
 * (frontend/src/lib/emailRule.ts): an address this refuses is dropped without an answer that
 * says so, so the form must refuse it first. Both sides' tests fail when the two differ.
 */
export const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/** The address as registration stores it: trimmed and lowercased. */
export const normaliseEmail = (email: string): string => email.trim().toLowerCase();

/** True when registration would accept the address's shape. */
export const isEmailShape = (email: string): boolean => EMAIL_RE.test(normaliseEmail(email));
