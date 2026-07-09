const PREFILL_PARAM = "prefill";
const MAX_PREFILL_LENGTH = 500;

function stripMarkup(value: string): string {
	if (typeof DOMParser === "undefined") {
		// non-DOM environments only: no angle brackets means no tags at all
		return value.replace(/[<>]/g, "");
	}
	const parsed = new DOMParser().parseFromString(value, "text/html");
	return parsed.body.textContent ?? "";
}

export function sanitizeChatPrefill(value: string | null): string | null {
	if (!value) return null;
	const sanitized = stripMarkup(value)
		.split("\0")
		.join("")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.trim()
		.slice(0, MAX_PREFILL_LENGTH);
	return sanitized.length > 0 ? sanitized : null;
}

export function consumeChatPrefill(search: string): {
	prefill: string | null;
	search: string;
} {
	const params = new URLSearchParams(search);
	const prefill = sanitizeChatPrefill(params.get(PREFILL_PARAM));
	params.delete(PREFILL_PARAM);
	const nextSearch = params.toString();
	return {
		prefill,
		search: nextSearch ? `?${nextSearch}` : "",
	};
}
