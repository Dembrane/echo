/**
 * Relative-time + duration helpers used by every "usage" surface.
 *
 * Centralized so the Usage / Members / Billing views speak the same
 * language: "Updated 5 min ago" instead of a raw timestamp, and "43
 * min" instead of "0.72 h". The second one is a persistent point of
 * confusion when the number rounds into a fraction of an hour.
 */

export function formatRelativeAgo(ms: number | undefined | null): string {
	if (!ms) return "";
	const diff = Date.now() - ms;
	if (diff < 30_000) return "just now";
	if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
	if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
	if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`;
	return `${Math.round(diff / 86_400_000)} d ago`;
}

/**
 * Format a duration given in hours as human-readable copy.
 *
 *   0            → "0 min"
 *   0.03 (~2m)   → "2 min"
 *   0.73 (~44m)  → "44 min"
 *   1            → "1h"
 *   1.5          → "1h 30m"
 *   2.17         → "2h 10m"
 *
 * Anything under a full hour renders as minutes; anything above drops
 * the minutes if they're zero to keep "3h" from reading "3h 0m".
 * Minimum one minute for any positive sub-minute value so "30 seconds
 * of audio" doesn't show as "0 min".
 */
export function formatDurationFromHours(hours: number | null | undefined): string {
	if (hours == null || !Number.isFinite(hours) || hours <= 0) return "0 min";
	const totalMins = Math.max(1, Math.round(hours * 60));
	if (totalMins < 60) return `${totalMins} min`;
	const h = Math.floor(totalMins / 60);
	const m = totalMins % 60;
	if (m === 0) return `${h}h`;
	return `${h}h ${m}m`;
}
