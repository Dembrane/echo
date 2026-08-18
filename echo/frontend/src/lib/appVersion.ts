// Stale-deploy recovery: a tab holding an old index.html requests hashed chunks
// the newest deploy no longer serves. Both halves confirm a newer build first.

import posthog from "posthog-js";

// `typeof` guard so a missing `define` disables the mechanism instead of throwing.
export const BUILD_ID: string =
	typeof __APP_BUILD_ID__ === "string" ? __APP_BUILD_ID__ : "unknown";

const VERSION_URL = "/version.json";
const MIN_CHECK_INTERVAL_MS = 60_000;
const MAX_RELOADS_PER_SESSION = 3;

const COUNT_KEY = "dembrane:version-reloads";
const targetKey = (target: string) => `dembrane:version-reload:${target}`;

export type ReloadReason = "new_version_detected" | "chunk_load_failed";

/** Dev emits no manifest, so there is nothing to compare against. */
const isEnabled = (): boolean => !import.meta.env.DEV && BUILD_ID !== "unknown";

/** sessionStorage, or null where it throws (private mode, blocked frames). */
const openGuardStore = (): Storage | null => {
	try {
		const probe = "dembrane:version-probe";
		sessionStorage.setItem(probe, "1");
		sessionStorage.removeItem(probe);
		return sessionStorage;
	} catch {
		return null;
	}
};

/** Returns whether the reload was taken, so callers can fall back on false. */
export const reloadForNewVersion = (
	reason: ReloadReason,
	targetBuildId: string | null,
): boolean => {
	// A dead chunk and a dead network look alike; reloading offline is worse.
	if (typeof navigator !== "undefined" && navigator.onLine === false) {
		return false;
	}

	const store = openGuardStore();
	// No persistence means no way to bound the reloads.
	if (!store) return false;

	// Keyed on the target, not the running build, so one reload doesn't disarm
	// the tab for the next deploy.
	const key = targetKey(targetBuildId ?? "unknown");
	if (store.getItem(key)) return false;

	// Backstop for a manifest reporting a stream of different targets.
	const count = Number.parseInt(store.getItem(COUNT_KEY) ?? "0", 10) || 0;
	if (count >= MAX_RELOADS_PER_SESSION) return false;

	store.setItem(key, "1");
	store.setItem(COUNT_KEY, String(count + 1));

	posthog.capture(
		"app_version_reloaded",
		{ build_id: BUILD_ID, reason, target_build_id: targetBuildId },
		// The reload races the batch queue.
		{ send_instantly: true, transport: "sendBeacon" },
	);
	window.location.reload();
	return true;
};

/** Build id the server is currently serving, or null if it can't be read. */
const fetchDeployedBuildId = async (): Promise<string | null> => {
	try {
		const response = await fetch(VERSION_URL, { cache: "no-store" });
		if (!response.ok) return null;
		const body = (await response.json()) as { buildId?: unknown };
		return typeof body.buildId === "string" ? body.buildId : null;
	} catch {
		return null;
	}
};

let recovering = false;

/** Reactive path: a dynamic import failed. */
export const recoverFromChunkFailure = async (): Promise<void> => {
	// Deduped: the idle prefetch can fail on several chunks at once.
	if (!isEnabled() || recovering) return;
	recovering = true;

	try {
		const deployed = await fetchDeployedBuildId();

		// Unreadable manifest, but the route is dead either way.
		if (deployed === null) {
			reloadForNewVersion("chunk_load_failed", null);
			return;
		}

		// Chunk is missing from the deploy we are already on, so reloading cannot
		// help. Let it fall through to the ErrorBoundary.
		if (deployed === BUILD_ID) return;

		reloadForNewVersion("chunk_load_failed", deployed);
	} finally {
		recovering = false;
	}
};

let lastCheckedAt = 0;

const checkForNewVersion = async (): Promise<void> => {
	if (!isEnabled()) return;

	const now = Date.now();
	if (now - lastCheckedAt < MIN_CHECK_INTERVAL_MS) return;
	lastCheckedAt = now;

	const deployed = await fetchDeployedBuildId();
	if (deployed === null || deployed === BUILD_ID) return;

	reloadForNewVersion("new_version_detected", deployed);
};

interface SubscribableRouter {
	subscribe: (
		fn: (state: { location: { pathname: string } }) => void,
	) => () => void;
	state: { location: { pathname: string } };
}

/**
 * Proactive path. Route changes only: a navigation already discards screen
 * state, whereas a timer or tab focus could yank a half-filled form.
 */
export const watchForNewVersion = (
	router: SubscribableRouter,
): (() => void) => {
	void checkForNewVersion();

	let lastPathname = router.state.location.pathname;

	return router.subscribe((state) => {
		if (state.location.pathname === lastPathname) return;
		lastPathname = state.location.pathname;
		void checkForNewVersion();
	});
};
