/**
 * Frozen-feature-attempt signal.
 *
 * Matrix v1.1 §3: the 7-day post-downgrade banner is dismissable but
 * "auto-returns if the admin attempts a frozen feature." This bus
 * carries that signal — FeatureGate fires when its tier-gate modal
 * opens; DowngradeBanner listens and clears its session dismissal.
 *
 * Same pattern as lib/pilotBlock.ts: window CustomEvent so any caller
 * can fire without threading a context.
 */

const EVENT_NAME = "dembrane:frozen-feature-attempt";

export function emitFrozenFeatureAttempt() {
	window.dispatchEvent(new Event(EVENT_NAME));
}

export function onFrozenFeatureAttempt(handler: () => void) {
	window.addEventListener(EVENT_NAME, handler);
	return () => window.removeEventListener(EVENT_NAME, handler);
}
