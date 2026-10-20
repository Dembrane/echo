import type { FreeAllowance } from "@/hooks/useFreeAllowance";
import { readApiError } from "./errors/read";

// Detects the shared free-tier 402 contract raised by the backend
// (dembrane/free_tier.py free_tier_limit_error). Frontend gates and the
// UpgradeModal key on this.

export type FreeTierLimit =
	| "chats"
	| "chat_turns"
	| "report"
	| "workspaces"
	| "projects"
	| "organisations"
	| "audio_month"
	| "audio_conversation"
	| "recording_project"
	| "map"
	| "popcorn";

/** The limits that stop a recording or an upload. */
export type RecordingRefusal =
	| "audio_month"
	| "audio_conversation"
	| "recording_project";

const LIMITS: ReadonlySet<string> = new Set<FreeTierLimit>([
	"chats",
	"chat_turns",
	"report",
	"workspaces",
	"projects",
	"organisations",
	"audio_month",
	"audio_conversation",
	"recording_project",
	"map",
	"popcorn",
]);

const RECORDING_REFUSALS: ReadonlySet<string> = new Set<RecordingRefusal>([
	"audio_month",
	"audio_conversation",
	"recording_project",
]);

/** A chat's turn meter: a frozen chat (opened before the free limits) takes no more turns. */
export function chatTurnGate(
	t: { limit: number; used: number; frozen: boolean } | null | undefined,
): { atLimit: boolean; frozen: boolean } {
	if (!t) return { atLimit: false, frozen: false };
	return { atLimit: t.frozen || t.used >= t.limit, frozen: t.frozen };
}

/** True when a free account has used this month's meter up. */
export function allowanceSpent(
	s: FreeAllowance | undefined,
	key: "chats" | "reports" | "maps" | "popcorn_analyses",
): boolean {
	const meter = s?.free ? s[key] : null;
	return !!meter && meter.used >= meter.limit;
}

const FREE_TIER_LIMIT_ERROR = "FREE_TIER_LIMIT";

/**
 * Returns the limit name when `err` carries the shared free-tier 402 body,
 * otherwise null. Handles both the axios-style api client (err.response.data.detail)
 * and a plain fetch path where the parsed JSON detail was attached.
 */
export function isFreeTierLimitError(err: unknown): FreeTierLimit | null {
	// The platform's code for it; the details shape below covers the Python API.
	const coded = readApiError(err);
	if (coded.code === "billing.tier_limit" && isLimit(coded.params.limit))
		return coded.params.limit;
	const detail = extractDetail(err);
	if (
		detail &&
		typeof detail === "object" &&
		(detail as { error?: unknown }).error === FREE_TIER_LIMIT_ERROR
	) {
		const limit = (detail as { limit?: unknown }).limit;
		if (isLimit(limit)) return limit;
	}
	return null;
}

/** The free-limit 402's details object (the body's `detail`), or null. */
export function freeLimitDetails(
	err: unknown,
): Readonly<Record<string, unknown>> | null {
	if (!isFreeTierLimitError(err)) return null;
	const detail = extractDetail(err);
	return detail && typeof detail === "object" && !Array.isArray(detail)
		? (detail as Record<string, unknown>)
		: null;
}

/** The recording reason of a free-limit 402, or null for anything else. */
export function portalRecordingRefusal(err: unknown): RecordingRefusal | null {
	const limit = isFreeTierLimitError(err);
	return isRecordingRefusal(limit) ? limit : null;
}

/** Reads `recording_stop` off a live chunk confirm response. */
export function recordingStopOf(chunk: unknown): RecordingRefusal | null {
	if (!chunk || typeof chunk !== "object") return null;
	const stop = (chunk as { recording_stop?: unknown }).recording_stop;
	return isRecordingRefusal(stop) ? stop : null;
}

function extractDetail(err: unknown): unknown {
	if (!err || typeof err !== "object") return null;
	// axios-style: err.response.data.detail
	const response = (err as { response?: { data?: { detail?: unknown } } })
		.response;
	if (response?.data?.detail !== undefined) return response.data.detail;
	// plain object with a detail field
	const detail = (err as { detail?: unknown }).detail;
	if (detail !== undefined) return detail;
	return null;
}

function isLimit(v: unknown): v is FreeTierLimit {
	return typeof v === "string" && LIMITS.has(v);
}

function isRecordingRefusal(v: unknown): v is RecordingRefusal {
	return typeof v === "string" && RECORDING_REFUSALS.has(v);
}
