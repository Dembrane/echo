import { ADMIN_BASE_URL, API_BASE_URL } from "@/config";

// Better Auth endpoints on the platform API. Errors are thrown in the
// { errors: [{ message, extensions: { code } }] } shape the auth pages already
// read, so login, reset and verify screens work unchanged.

const AUTH = `${API_BASE_URL}/auth`;

const DEVICE_KEY = "dembrane:device";
let ephemeralDevice = "";

/**
 * A random id this browser keeps, sent with every auth call so the server can tell a
 * sign-in from a second browser apart from the same one signing in again. Not a
 * fingerprint: it holds nothing about the machine, and clearing site data makes a new one.
 */
function deviceId(): string {
	try {
		const existing = localStorage.getItem(DEVICE_KEY);
		if (existing) return existing;
		const fresh = crypto.randomUUID();
		localStorage.setItem(DEVICE_KEY, fresh);
		return fresh;
	} catch {
		// Storage is blocked: one id for as long as the page lives.
		if (!ephemeralDevice) {
			ephemeralDevice = `tab-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
		}
		return ephemeralDevice;
	}
}

export class AuthError extends Error {
	readonly errors: { message: string; extensions: { code: string } }[];
	constructor(message: string, code: string) {
		super(message);
		this.errors = [{ extensions: { code }, message }];
	}
}

async function post<T>(path: string, body: unknown): Promise<T> {
	const res = await fetch(`${AUTH}${path}`, {
		body: JSON.stringify(body),
		credentials: "include",
		headers: { "Content-Type": "application/json", "x-device-id": deviceId() },
		method: "POST",
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		const code =
			typeof data?.code === "string" ? data.code : `HTTP_${res.status}`;
		throw new AuthError(messageFor(code, data?.message), code);
	}
	return data as T;
}

/** The texts people saw from Directus for the same situations. */
function messageFor(code: string, fallback?: string): string {
	switch (code) {
		case "INVALID_EMAIL_OR_PASSWORD":
			return "Invalid user credentials.";
		case "INVALID_CODE":
		case "INVALID_TWO_FACTOR_CODE":
			return "Invalid user OTP.";
		case "EMAIL_NOT_VERIFIED":
			return "Your email is not verified yet. Check your inbox for the verification link.";
		case "INVALID_OTP":
		case "OTP_EXPIRED":
			return "That code is not right or has expired. Request a new one.";
		case "TOO_MANY_ATTEMPTS":
			return "Too many tries. Request a new code.";
		case "INVALID_TOKEN":
			return "Invalid or expired link. Request a new one.";
		default:
			return fallback || "Something went wrong";
	}
}

/**
 * Signs in with email and password. When the account has two-factor on, the first call
 * reports it and the code goes to a second call, matching Directus's INVALID_OTP flow.
 */
export async function signIn(
	email: string,
	password: string,
	otp?: string,
): Promise<void> {
	const res = await post<{ twoFactorRedirect?: boolean }>("/sign-in/email", {
		email,
		password,
	});
	if (!res.twoFactorRedirect) return;
	if (!otp) throw new AuthError("Two-factor code required.", "INVALID_OTP");
	try {
		await post("/two-factor/verify-totp", { code: otp });
	} catch {
		throw new AuthError("Invalid user OTP.", "INVALID_OTP");
	}
}

/**
 * Emails a one-time sign-in code (Better Auth's email OTP). Contacts that staff or sam
 * create sign in this way; they may never set a password.
 */
export async function sendSignInCode(email: string): Promise<void> {
	await post("/email-otp/send-verification-otp", { email, type: "sign-in" });
}

export async function signInWithCode(
	email: string,
	otp: string,
): Promise<void> {
	await post("/sign-in/email-otp", { email, otp });
}

export async function signOut(): Promise<void> {
	await post("/sign-out", {});
}

/**
 * True when a session exists. Replaces Directus's refresh call as the session probe. A held
 * session (see otherSessions) signs nobody in, so it counts as none.
 */
export async function hasSession(): Promise<boolean> {
	const res = await fetch(`${AUTH}/get-session`, { credentials: "include" });
	if (!res.ok) return false;
	const data = await res.json().catch(() => null);
	return Boolean(data?.session) && data.session.held !== true;
}

/**
 * After a sign-in: whether the account is signed in on another browser, in which case the
 * new session is held until replaceOtherSessions, and since when. An API that cannot say
 * reads as not held, so sign-in is never blocked by this check.
 */
export async function otherSessions(): Promise<{
	held: boolean;
	since: string | null;
}> {
	try {
		const res = await fetch(`${AUTH}/other-sessions`, {
			credentials: "include",
			headers: { "x-device-id": deviceId() },
		});
		if (!res.ok) return { held: false, since: null };
		const data = await res.json();
		return {
			held: data?.held === true,
			since: typeof data?.since === "string" ? data.since : null,
		};
	} catch {
		return { held: false, since: null };
	}
}

/** Signs the account out everywhere else and completes the held sign-in on this browser. */
export async function replaceOtherSessions(): Promise<void> {
	await post("/other-sessions/replace", {});
}

export async function requestPasswordReset(email: string): Promise<void> {
	await post("/request-password-reset", {
		email,
		redirectTo: `${ADMIN_BASE_URL}/password-reset`,
	});
}

export async function resetPassword(
	token: string,
	newPassword: string,
): Promise<void> {
	await post("/reset-password", { newPassword, token });
}

/** Emails a fresh verification link; answers the same whether or not the address is known. */
export async function resendVerificationEmail(email: string): Promise<void> {
	await post("/send-verification-email", {
		callbackURL: `${ADMIN_BASE_URL}/verify-email`,
		email,
	});
}

export async function verifyEmail(token: string): Promise<void> {
	const res = await fetch(
		`${AUTH}/verify-email?token=${encodeURIComponent(token)}`,
		{
			credentials: "include",
			headers: { "x-device-id": deviceId() },
		},
	);
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		const code = typeof data?.code === "string" ? data.code : "INVALID_TOKEN";
		throw new AuthError(messageFor(code, data?.message), code);
	}
}
