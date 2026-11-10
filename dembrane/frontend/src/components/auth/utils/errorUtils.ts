import { t } from "@lingui/core/macro";
import type { LoginFailureCause } from "@/lib/analytics/events";

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

/** The HTTP status an AuthError carries, from its field or its HTTP_<status> code. */
export function authErrorStatus(e: unknown): number | null {
	const status = (e as { status?: unknown } | null)?.status;
	if (typeof status === "number") return status;
	const match = authErrorCode(e)?.match(/^HTTP_(\d{3})$/);
	return match ? Number(match[1]) : null;
}

/** Seconds the server asked to wait, when a rate-limited answer said. */
export function authRetryAfter(e: unknown): number | null {
	const seconds = (e as { retryAfterSeconds?: unknown } | null)
		?.retryAfterSeconds;
	return typeof seconds === "number" && seconds > 0 ? Math.ceil(seconds) : null;
}

/**
 * Why a sign-in failed, as analytics counts it (`user_login_failed.cause`) and as the login
 * page decides what to show. Never anything the person typed.
 */
export type { LoginFailureCause };

const WRONG_CREDENTIALS = new Set([
	"INVALID_EMAIL_OR_PASSWORD",
	"INVALID_EMAIL",
	"INVALID_CODE",
	"INVALID_TWO_FACTOR_CODE",
	"INVALID_OTP",
	"OTP_EXPIRED",
]);

const RATE_LIMITED = new Set([
	"TOO_MANY_ATTEMPTS",
	"HTTP_429",
	"rate_limit.exceeded",
]);

/** True when the request never got an answer: offline, DNS, a dropped connection. */
function isNetworkFailure(e: unknown): boolean {
	if (authErrorCode(e) === "TIMEOUT") return true;
	if (authErrorCode(e)) return false;
	if (typeof navigator !== "undefined" && navigator.onLine === false)
		return true;
	const message = e instanceof Error ? e.message : "";
	// Chrome, Firefox and Safari word the same failed fetch differently.
	return (
		message === "Failed to fetch" ||
		message === "Load failed" ||
		message.includes("NetworkError")
	);
}

export function loginFailureCause(e: unknown): LoginFailureCause {
	const code = authErrorCode(e);
	if (code === "EMAIL_NOT_VERIFIED") return "unverified";
	if (code && WRONG_CREDENTIALS.has(code)) return "wrong_credentials";
	if ((code && RATE_LIMITED.has(code)) || authErrorStatus(e) === 429)
		return "rate_limited";
	// A 403 with no code of ours: something in front of dembrane refused it. dembrane's own
	// refusals (an unverified email is a 403 too) always name a code.
	if (code === "HTTP_403") return "blocked";
	if (isNetworkFailure(e)) return "network";
	return "server";
}

/**
 * The sentence for an auth error. `flow` says which sign-in the person is in: a password
 * login never talks about a code, and the code sign-in keeps its own wording.
 */
export function describeAuthError(
	e: unknown,
	{ flow = "code" }: { flow?: "password" | "code" } = {},
): string {
	const code = authErrorCode(e);
	switch (code) {
		case "INVALID_EMAIL_OR_PASSWORD":
		// Kept generic on purpose: never says whether an account exists.
		case "INVALID_EMAIL":
			return t`The email or password is not right. Check them and try again.`;
		case "INVALID_CODE":
		case "INVALID_TWO_FACTOR_CODE":
			return t`That code did not work. Try again with a new code.`;
		case "EMAIL_NOT_VERIFIED":
			return t`Your email is not verified yet. Check your inbox for the verification link.`;
		case "INVALID_OTP":
		case "OTP_EXPIRED":
			return t`That code is not right or has expired. Request a new one.`;
		case "INVALID_TOKEN":
			return t`This link is not valid or has expired. Request a new one.`;
		default:
			break;
	}
	switch (loginFailureCause(e)) {
		case "rate_limited":
			return flow === "password"
				? t`Too many login attempts. Wait a moment, then try again.`
				: t`Too many tries. Wait a moment, then request a new code.`;
		case "blocked":
			return flow === "password"
				? t`Your login was stopped before it reached dembrane, so we could not check your details. Try another network or another browser.`
				: t`This request was stopped before it reached dembrane. Try another network or another browser.`;
		case "network":
			return code === "TIMEOUT"
				? t`This took too long. Try again.`
				: t`We could not reach dembrane. Check your internet connection and try again.`;
		default:
			return t`Something went wrong. Try again, and contact support if it keeps happening.`;
	}
}
