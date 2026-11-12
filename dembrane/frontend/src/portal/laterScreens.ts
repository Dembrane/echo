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

/** Fetches every later screen in the background, after the first render settles. */
export const prefetchLaterScreens = (): (() => void) => {
	const prefetch = () => {
		for (const load of Object.values(laterScreens)) {
			// A failed prefetch is retried when the screen is actually opened.
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
