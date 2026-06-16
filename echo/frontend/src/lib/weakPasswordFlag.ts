// Session flag (just a boolean) set at login when the password fails the
// policy, to nudge the user. Mirrors lib/authCacheBoundary.ts.

const STORAGE_KEY = "dembrane-weak-password";
export const WEAK_PASSWORD_EVENT = "dembrane.weak-password";

export function setWeakPasswordFlag(): void {
	if (typeof window === "undefined") return;
	try {
		sessionStorage.setItem(STORAGE_KEY, "1");
	} catch {}
	window.dispatchEvent(new Event(WEAK_PASSWORD_EVENT));
}

export function clearWeakPasswordFlag(): void {
	if (typeof window === "undefined") return;
	try {
		sessionStorage.removeItem(STORAGE_KEY);
	} catch {}
	window.dispatchEvent(new Event(WEAK_PASSWORD_EVENT));
}

export function isWeakPasswordFlagSet(): boolean {
	if (typeof window === "undefined") return false;
	try {
		return sessionStorage.getItem(STORAGE_KEY) === "1";
	} catch {
		return false;
	}
}
