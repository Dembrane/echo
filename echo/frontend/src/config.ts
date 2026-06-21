// ---------------------------------------------------------------------------
// App environment
//
// Deployments are told apart by hostname at runtime instead of per-deploy Vite
// env vars in Vercel. This is the single source of truth: base URLs, feature
// flags, PostHog routing, and the Logo env badge all read from here.
//
// To add or move a deployment, edit ENV_HOSTNAMES. Loopback hosts and dev
// builds resolve to "local". Anything else unmatched (Vercel preview URLs,
// LAN IPs, ...) falls back to "next": production must be an explicit match so
// stray hosts can never capture into prod analytics or mutate prod data.
// ---------------------------------------------------------------------------

export type AppEnvironment = "production" | "next" | "testing" | "local";

const ENV_HOSTNAMES: Record<"production" | "next" | "testing", string[]> = {
	next: ["dashboard.echo-next.dembrane.com", "portal.echo-next.dembrane.com"],
	production: ["dashboard.dembrane.com", "portal.dembrane.com"],
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
	return "next";
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
// All resolved in code; no deployment sets env vars for these.
// ---------------------------------------------------------------------------

// The portal (participant) and dashboard (admin) apps share this codebase.
// Deployed portals are portal.* hosts; locally the participant dev server is
// the one on port 5174 (`pnpm participant:dev`).
export const USE_PARTICIPANT_ROUTER = Boolean(
	globalThis.window?.location.hostname.startsWith("portal.") ||
		globalThis.window?.location.port === "5174",
);

export const ADMIN_BASE_URL = byEnv(
	{ local: "http://localhost:5173" },
	dembraneHost("dashboard"),
);

export const PARTICIPANT_BASE_URL = byEnv(
	{ local: "http://localhost:5174" },
	dembraneHost("portal"),
);

// FastAPI mounts its routes under /api; locally the Vite proxy forwards
// same-origin /api to localhost:8000.
export const API_BASE_URL = byEnv(
	{ local: "/api" },
	`${dembraneHost("api")}/api`,
);

export const DIRECTUS_PUBLIC_URL = byEnv(
	// Local dev goes through the Vite proxy so cookies stay same-origin.
	{ local: `${globalThis.window?.location.origin ?? ""}/directus` },
	dembraneHost("directus"),
);

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
	"cs-CZ",
] as const;

export const PRIVACY_POLICY_URL =
	"https://dembrane.notion.site/Privacy-statements-all-languages-fa97a183f9d841f7a1089079e77ffb52" as const;

// Legal pages (ISSUE-016). Absolute www.dembrane.com/legal/* links so they
// render even if the pages 404 for now (Founder decision D4). Wire now,
// resolve later.
export const LEGAL_TERMS_URL = "https://www.dembrane.com/legal/terms" as const;
export const LEGAL_PRIVACY_URL =
	"https://www.dembrane.com/legal/privacy" as const;
export const LEGAL_DPA_URL = "https://www.dembrane.com/legal/DPA" as const;

export const COMMUNITY_SLACK_URL =
	"https://join.slack.com/t/dembranecommunity/shared_invite/zt-3qzvryh8l-M6w3u5BvuM8LssOhMbJGgQ";

export const DEBUG_MODE = import.meta.env.VITE_DEBUG_MODE === "1";

export const ENABLE_CHAT_AUTO_SELECT = false;
export const ENABLE_CHAT_SELECT_ALL = true;
export const ENABLE_CONVERSATION_HEALTH = true;
export const ENABLE_ANNOUNCEMENTS = true;
export const ENABLE_DISPLAY_CONVERSATION_LINKS = true;
export const ENABLE_WEBHOOKS = true;
// Temporarily disabled everywhere. Restore with: byEnv({ production: false }, true)
// (on everywhere except production: local, testing/dev, next/staging → on).
export const ENABLE_AGENTIC_CHAT = false;
// Re-enabled on echo-next (2026-06-21). Runtime render gate only; the build
// always ships the (lazy) agentation chunk and JSX source metadata — other
// environments just never render or download it. Widen to more envs by adding
// keys here (e.g. local/testing) when ready to roll out further.
export const ENABLE_AGENTATION = byEnv({ next: true }, false);

export const getProductFeedbackUrl = (locale = "en-US") =>
	`https://portal.dembrane.com/${locale}/a2b7fbeb-af8d-41c8-b70b-9ff1f3c6d51a/start?theme=dm-sans`;
