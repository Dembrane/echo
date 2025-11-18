export const USE_PARTICIPANT_ROUTER =
	import.meta.env.VITE_USE_PARTICIPANT_ROUTER === "1";
export const ADMIN_BASE_URL =
	import.meta.env.VITE_ADMIN_BASE_URL ?? window.location.origin;
export const PARTICIPANT_BASE_URL =
	import.meta.env.VITE_PARTICIPANT_BASE_URL ?? window.location.origin;
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "/api";

// Resolve Directus base URL: supports absolute URLs or relative paths like "/directus"
// Relative paths are resolved to current origin to work with Vite proxy and dynamic ports
export const DIRECTUS_PUBLIC_URL = (() => {
	const env = import.meta.env.VITE_DIRECTUS_PUBLIC_URL;
	// If absolute URL, use as-is
	if (env?.startsWith("http")) return env;
	// If relative path, resolve to current origin (for Vite proxy)
	if (env?.startsWith("/")) return `${window.location.origin}${env}`;
	// Default fallback
	return "http://localhost:8055";
})();

export const DIRECTUS_CONTENT_PUBLIC_URL =
	import.meta.env.VITE_DIRECTUS_CONTENT_PUBLIC_URL ??
	"https://dembrane.directus.app";

export const DISABLE_SENTRY = import.meta.env.VITE_DISABLE_SENTRY === "1";

export const BUILD_VERSION = import.meta.env.VITE_BUILD_VERSION ?? "dev";

export const SUPPORTED_LANGUAGES = [
	"en-US",
	"nl-NL",
	"de-DE",
	"fr-FR",
	"es-ES",
] as const;

export const PRIVACY_POLICY_URL =
	"https://dembrane.notion.site/Privacy-statements-all-languages-fa97a183f9d841f7a1089079e77ffb52" as const;


export const PLAUSIBLE_API_HOST =
	import.meta.env.VITE_PLAUSIBLE_API_HOST ?? "https://plausible.io";

export const DEBUG_MODE = import.meta.env.VITE_DEBUG_MODE === "1";

export const ENABLE_CHAT_AUTO_SELECT = true;
export const ENABLE_CONVERSATION_HEALTH = true;
export const ENABLE_ANNOUNCEMENTS = true;
export const ENABLE_DISPLAY_CONVERSATION_LINKS = true;
