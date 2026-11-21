// Screens a participant reaches only once a conversation is under way. Each is
// its own chunk, kept out of the first load (scripts/check-portal-bundle.mjs),
// and prefetched once the portal is idle so a tap mid-session, often on a poor
// network, doesn't wait on a download.
export const laterScreens = {
	finish: () => import("./routes/ParticipantPostConversation"),
	refine: () => import("./components/refine/RefineSelection"),
	verify: () => import("./components/verify/Verify"),
	verifyArtefact: () => import("./components/verify/VerifyArtefact"),
	verifySelection: () => import("./components/verify/VerifySelection"),
};

type LaterScreen = keyof typeof laterScreens;

/** The module address in a failed dynamic import's message (Chromium, Firefox). */
export const failedImportUrl = (error: unknown): string | null => {
	const message = error instanceof Error ? error.message : String(error);
	return message.match(/https?:\/\/[^\s'"]+/)?.[0] ?? null;
};

const RELOAD_KEY = "portal_later_screen_reload_at";
const RELOAD_COOLDOWN_MS = 60_000;

// At most one reload a minute, so a chunk that is really gone can't loop the page.
const reloadOnce = (): boolean => {
	if (navigator.onLine === false) return false;
	try {
		const last = Number(window.sessionStorage.getItem(RELOAD_KEY) ?? 0);
		if (Date.now() - last < RELOAD_COOLDOWN_MS) return false;
		window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
	} catch {
		return false;
	}
	window.location.reload();
	return true;
};

/**
 * Loads a later screen when it opens. Browsers never refetch a failed import, so retry it
 * under a fresh address; if that fails, finish reloads once (the conversation is over),
 * while refine and verify show their error and leave the live recorder alone.
 */
export const openLaterScreen = <K extends LaterScreen>(
	screen: K,
): ReturnType<(typeof laterScreens)[K]> =>
	loadWithRetry(laterScreens[screen], screen === "finish") as ReturnType<
		(typeof laterScreens)[K]
	>;

const loadWithRetry = async (
	load: () => Promise<unknown>,
	reloadAsLastResort: boolean,
): Promise<unknown> => {
	try {
		return await load();
	} catch (error) {
		const url = failedImportUrl(error);
		try {
			if (!url) throw error;
			const fresh = `${url}${url.includes("?") ? "&" : "?"}retry=${Date.now()}`;
			return await import(/* @vite-ignore */ fresh);
		} catch (retryError) {
			// Never settles: the page is reloading.
			if (reloadAsLastResort && reloadOnce()) return new Promise(() => {});
			throw retryError;
		}
	}
};

/** Fetches every later screen in the background, after the first render settles. */
export const prefetchLaterScreens = (): (() => void) => {
	const prefetch = () => {
		for (const load of Object.values(laterScreens)) {
			// A failure here is retried by openLaterScreen when the screen opens.
			load().catch(() => {});
		}
	};
	if (typeof window.requestIdleCallback === "function") {
		const handle = window.requestIdleCallback(prefetch, { timeout: 3000 });
		return () => window.cancelIdleCallback(handle);
	}
	const timeout = window.setTimeout(prefetch, 1500);
	return () => window.clearTimeout(timeout);
};
