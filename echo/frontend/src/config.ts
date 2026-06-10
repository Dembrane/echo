// ---------------------------------------------------------------------------
// App environment
//
// Deployments are told apart by hostname at runtime instead of per-deploy Vite
// env vars in Vercel. This is the single source of truth: base URLs, feature
// flags, PostHog routing, and the Logo env badge all read from here.
//
// To add or move a deployment, edit ENV_HOSTNAMES. Loopback hosts and dev
// builds resolve to "local"; anything else unmatched falls back to
// "production".
// ---------------------------------------------------------------------------

export type AppEnvironment = "production" | "next" | "testing" | "local";

const ENV_HOSTNAMES: Record<"next" | "testing", string[]> = {
	next: ["dashboard.echo-next.dembrane.com", "portal.echo-next.dembrane.com"],
	testing: [
		"dashboard.echo-testing.dembrane.com",
		"portal.echo-testing.dembrane.com",
	],
};

const LOCAL_HOSTNAMES = ["localhost", "127.0.0.1", "0.0.0.0"];

export const APP_ENVIRONMENT: AppEnvironment = (() => {
	if (typeof window === "undefined") return "production";
	const { host, hostname } = window.location;
	for (const [env, hosts] of Object.entries(ENV_HOSTNAMES)) {
		if (hosts.includes(host)) return env as AppEnvironment;
	}
	// Any loopback host counts as local regardless of port (pnpm dev, vite
	// preview, ...) so a prod build run locally never pollutes prod analytics.
	if (LOCAL_HOSTNAMES.includes(hostname) || import.meta.env.DEV) {
		return "local";
	}
	return "production";
})();

export const IS_PRODUCTION = APP_ENVIRONMENT === "production";

/**
 * Resolve a value for the current environment. List only the environments that
 * differ from the default; everything else falls back to `fallback`.
 *
 *   const apiBase = byEnv({ local: "http://localhost:8000" }, "/api");
 */
export const byEnv = <T>(
	overrides: Partial<Record<AppEnvironment, T>>,
	fallback: T,
): T => overrides[APP_ENVIRONMENT] ?? fallback;

/** `https://<subdomain>.echo-next.dembrane.com` etc. for the current env. */
const dembraneHost = (subdomain: string): string =>
	byEnv(
		{
			next: `https://${subdomain}.echo-next.dembrane.com`,
			testing: `https://${subdomain}.echo-testing.dembrane.com`,
		},
		`https://${subdomain}.dembrane.com`,
	);

// ---------------------------------------------------------------------------
// Routers and base URLs
//
// All resolved in code; the VITE_* overrides are escape hatches only and no
// deployment needs to set them.
// ---------------------------------------------------------------------------

// The portal (participant) and dashboard (admin) apps share this codebase.
// Deployed portals are portal.* hosts; local participant dev sets the env var
// via the `participant:dev` script.
export const USE_PARTICIPANT_ROUTER =
	import.meta.env.VITE_USE_PARTICIPANT_ROUTER === "1" ||
	Boolean(globalThis.window?.location.hostname.startsWith("portal."));

export const ADMIN_BASE_URL =
	import.meta.env.VITE_ADMIN_BASE_URL ??
	byEnv({ local: "http://localhost:5173" }, dembraneHost("dashboard"));

export const PARTICIPANT_BASE_URL =
	import.meta.env.VITE_PARTICIPANT_BASE_URL ??
	byEnv({ local: "http://localhost:5174" }, dembraneHost("portal"));

// FastAPI mounts its routes under /api; locally the Vite proxy forwards
// same-origin /api to localhost:8000.
export const API_BASE_URL =
	import.meta.env.VITE_API_BASE_URL ??
	byEnv({ local: "/api" }, `${dembraneHost("api")}/api`);

// Resolve Directus base URL: the override supports absolute URLs or relative
// paths like "/directus" (resolved to current origin for the Vite proxy).
export const DIRECTUS_PUBLIC_URL = (() => {
	const env = import.meta.env.VITE_DIRECTUS_PUBLIC_URL;
	if (env?.startsWith("http")) return env;
	if (env?.startsWith("/")) return `${window.location.origin}${env}`;
	return byEnv(
		// Local dev goes through the Vite proxy so cookies stay same-origin.
		{ local: `${window.location.origin}/directus` },
		dembraneHost("directus"),
	);
})();

// ---------------------------------------------------------------------------
// PostHog (analytics)
//
// Tokens are project ingest keys, safe to ship publicly. production and next
// report into their own EU projects; testing and local opt out entirely.
// ---------------------------------------------------------------------------

export const POSTHOG_HOST = "https://eu.i.posthog.com";

export const POSTHOG_TOKEN = byEnv(
	// echo (production): project 160282
	{ production: "phc_o9ZqNqaop7cwLvbbEU2gwvaY5CczpavbNfCxrnu2Ca4a" },
	// echo-next: project 197841, also used by testing and local
	"phc_qMo8i67hwneqDG3x8NW4iTyUiqPMsR9pZ3H5QaJQ4zkM",
);

export const POSTHOG_CAPTURE = byEnv({ local: false, testing: false }, true);

export const SUPPORTED_LANGUAGES = [
	"en-US",
	"nl-NL",
	"de-DE",
	"fr-FR",
	"es-ES",
	"it-IT",
	"uk-UA",
] as const;

export const PRIVACY_POLICY_URL =
	"https://dembrane.notion.site/Privacy-statements-all-languages-fa97a183f9d841f7a1089079e77ffb52" as const;

export const PLAUSIBLE_API_HOST =
	import.meta.env.VITE_PLAUSIBLE_API_HOST ?? "https://plausible.io";

export const COMMUNITY_SLACK_URL =
	import.meta.env.VITE_COMMUNITY_SLACK_URL ??
	"https://join.slack.com/t/dembranecommunity/shared_invite/zt-3qzvryh8l-M6w3u5BvuM8LssOhMbJGgQ";

export const DEBUG_MODE = import.meta.env.VITE_DEBUG_MODE === "1";

export const ENABLE_CHAT_AUTO_SELECT = false;
export const ENABLE_CHAT_SELECT_ALL = true;
export const ENABLE_CONVERSATION_HEALTH = true;
export const ENABLE_ANNOUNCEMENTS = true;
export const ENABLE_DISPLAY_CONVERSATION_LINKS = true;
export const ENABLE_WEBHOOKS = true;
// On everywhere except production (local, testing/dev, next/staging → on).
export const ENABLE_AGENTIC_CHAT = byEnv({ production: false }, true);
// Same rollout as agentic chat. Runtime render gate only; the build always
// ships the (lazy) agentation chunk and JSX source metadata, production just
// never renders or downloads it.
export const ENABLE_AGENTATION = byEnv({ production: false }, true);

export const getProductFeedbackUrl = (locale = "en-US") =>
	`https://portal.dembrane.com/${locale}/a2b7fbeb-af8d-41c8-b70b-9ff1f3c6d51a/start?theme=dm-sans`;
