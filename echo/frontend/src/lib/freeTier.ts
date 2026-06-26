// Detects the shared free-tier 402 contract raised by the backend
// (dembrane/free_tier.py free_tier_limit_error). Frontend gates and the
// UpgradeModal key on this.

export type FreeTierLimit = "chats" | "chat_turns" | "report" | "workspaces";

// Mirror of the backend limits in dembrane/free_tier.py. Kept in sync by hand;
// the backend remains the source of truth and enforces these via 402.
export const FREE_TIER_MAX_CHATS = 1;
export const FREE_TIER_MAX_CHAT_USER_TURNS = 3;

const FREE_TIER_LIMIT_ERROR = "FREE_TIER_LIMIT";

/**
 * Returns the limit name when `err` carries the shared free-tier 402 body,
 * otherwise null. Handles both the axios-style api client (err.response.data.detail)
 * and a plain fetch path where the parsed JSON detail was attached.
 */
export function isFreeTierLimitError(err: unknown): FreeTierLimit | null {
	const detail = extractDetail(err);
	if (
		detail &&
		typeof detail === "object" &&
		(detail as { error?: unknown }).error === FREE_TIER_LIMIT_ERROR
	) {
		const limit = (detail as { limit?: unknown }).limit;
		if (
			limit === "chats" ||
			limit === "chat_turns" ||
			limit === "report" ||
			limit === "workspaces"
		) {
			return limit;
		}
	}
	return null;
}

function extractDetail(err: unknown): unknown {
	if (!err || typeof err !== "object") return null;
	// axios-style: err.response.data.detail
	const response = (err as { response?: { data?: { detail?: unknown } } }).response;
	if (response?.data?.detail !== undefined) return response.data.detail;
	// plain object with a detail field
	const detail = (err as { detail?: unknown }).detail;
	if (detail !== undefined) return detail;
	return null;
}
