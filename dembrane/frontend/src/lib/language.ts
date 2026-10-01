import { SUPPORTED_LANGUAGES } from "@/config";

// Language otherwise lives only in the URL prefix; persist it so it survives
// reloads and prefix-less entries (bare domain, bookmark, the login ?next).
export const LANGUAGE_STORAGE_KEY = "dembrane-language";

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const isSupportedLanguage = (
	value: string | null | undefined,
): value is SupportedLanguage =>
	!!value && SUPPORTED_LANGUAGES.some((lang) => lang === value);

export const readStoredLanguage = (): SupportedLanguage | null => {
	if (typeof window === "undefined") return null;
	try {
		const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
		return isSupportedLanguage(stored) ? stored : null;
	} catch {
		return null;
	}
};

export const storeLanguage = (language: string): void => {
	if (typeof window === "undefined" || !isSupportedLanguage(language)) return;
	try {
		window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
	} catch {
		// Private-mode / storage-disabled: fall back to URL-only behaviour.
	}
};

// Strip a leading /<lang> segment; the lookahead avoids false matches like /en-USA.
const LANGUAGE_PREFIX_RE = new RegExp(
	`^/(?:${SUPPORTED_LANGUAGES.join("|")})(?=/|$|\\?|#)`,
);

export const stripLanguagePrefix = (path: string): string =>
	path.replace(LANGUAGE_PREFIX_RE, "");
