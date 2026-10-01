import { t } from "@lingui/core/macro";

/**
 * Sign-in, reset and verify errors come from Better Auth, not from the platform's error
 * catalog: lib/auth.ts throws AuthError with Better Auth's code in errors[0]. This turns
 * that code into a friendly sentence in the person's language; anything else reads as the
 * generic message, never the server's text.
 */
export function authErrorCode(e: unknown): string | null {
	const errors = (
		e as { errors?: { extensions?: { code?: unknown } }[] } | null
	)?.errors;
	const code = Array.isArray(errors) ? errors[0]?.extensions?.code : undefined;
	return typeof code === "string" ? code : null;
}

export function describeAuthError(e: unknown): string {
	const code = authErrorCode(e);
	switch (code) {
		case "INVALID_EMAIL_OR_PASSWORD":
			return t`The email or password is not right. Check them and try again.`;
		case "INVALID_CODE":
		case "INVALID_TWO_FACTOR_CODE":
			return t`That code did not work. Try again with a new code.`;
		case "EMAIL_NOT_VERIFIED":
			return t`Your email is not verified yet. Check your inbox for the verification link.`;
		case "INVALID_OTP":
		case "OTP_EXPIRED":
			return t`That code is not right or has expired. Request a new one.`;
		case "TOO_MANY_ATTEMPTS":
		case "HTTP_429":
			return t`Too many tries. Wait a moment, then request a new code.`;
		case "INVALID_TOKEN":
			return t`This link is not valid or has expired. Request a new one.`;
		case "TIMEOUT":
			return t`This took too long. Try again.`;
		default:
			break;
	}
	const message = e instanceof Error ? e.message : "";
	if (message === "Failed to fetch" || message.includes("NetworkError"))
		return t`We could not reach dembrane. Check your internet connection and try again.`;
	return t`Something went wrong. Try again, and contact support if it keeps happening.`;
}
