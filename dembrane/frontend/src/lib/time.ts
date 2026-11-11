import { t } from "@lingui/core/macro";

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
	if (diff < 30_000) return t`just now`;
	const n = (unit: number) => Math.round(diff / unit);
	if (diff < 60_000) return t`${n(1000)}s ago`;
	if (diff < 3_600_000) return t`${n(60_000)} min ago`;
	if (diff < 86_400_000) return t`${n(3_600_000)} h ago`;
	return t`${n(86_400_000)} d ago`;
}

// Each unit is its own message, so translators can change the abbreviations.
const hoursPart = (h: number) =>
	t({ comment: "Hours, abbreviated, as in 2h 10m", message: `${h}h` });
const minutesPart = (m: number) =>
	t({ comment: "Minutes after hours, as in 2h 10m", message: `${m}m` });
const secondsPart = (s: number) =>
	t({ comment: "Seconds after hours, as in 1h 0m 2s", message: `${s}s` });
const minutesAlone = (m: number) =>
	t({ comment: "Minutes under an hour, as in 45 min", message: `${m} min` });
const secondsAlone = (s: number) =>
	t({ comment: "Seconds under an hour, as in 3 min 20 s", message: `${s} s` });

function renderDuration(h: number, m: number, s: number): string {
	if (h > 0) {
		const parts = [hoursPart(h)];
		if (m > 0 || s > 0) parts.push(minutesPart(m));
		if (s > 0) parts.push(secondsPart(s));
		return parts.join(" ");
	}
	if (m > 0)
		return s > 0 ? `${minutesAlone(m)} ${secondsAlone(s)}` : minutesAlone(m);
	return secondsAlone(s);
}

/**
 * Seconds as copy, the one duration format for usage, meters and upload refusals.
 *
 *   "minute": nearest minute, at least 1 for anything positive: "0 min", "44 min", "2h 10m"
 *   "second": seconds under an hour, whole minutes above: "15 s", "3 min 45 s", "1h 30m"
 *   "exact":  seconds everywhere: "1h 0m 2s"
 */
export function formatDuration(
	seconds: number | null | undefined,
	precision: "minute" | "second" | "exact" = "minute",
): string {
	const valid = seconds != null && Number.isFinite(seconds) && seconds > 0;
	if (precision === "minute") {
		if (!valid) return minutesAlone(0);
		const total = Math.max(1, Math.round(seconds / 60));
		return renderDuration(Math.floor(total / 60), total % 60, 0);
	}
	const total = valid ? Math.round(seconds) : 0;
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = precision === "second" && h > 0 ? 0 : total % 60;
	return renderDuration(h, m, s);
}

/** Hours as copy: "44 min", "1h", "2h 10m". */
export function formatDurationFromHours(
	hours: number | null | undefined,
): string {
	return formatDuration(hours == null ? hours : hours * 3600);
}

/** Seconds as the usage API shows them: hours to two decimals, then formatted. */
export function formatDurationFromSeconds(
	seconds: number | null | undefined,
): string {
	if (seconds == null || !Number.isFinite(seconds)) return formatDuration(0);
	return formatDurationFromHours(Math.round(seconds / 36) / 100);
}
