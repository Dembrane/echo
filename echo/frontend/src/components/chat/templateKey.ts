/**
 * Canonical template key system.
 *
 * Every template in the system gets a single string key that encodes
 * both its source and ID. This replaces the previous 4 identity systems:
 *   - Database ID + type tuple
 *   - QuickAccessItem {type, id}
 *   - Manual "user:${id}" / title-as-key strings
 *   - DnD sort ID "${type}-${id}"
 *
 * Format:
 *   Built-in (dembrane):  "dembrane:summarize"
 *   User-created:         "user:abc-123-uuid"
 *   Suggestion:           "suggestion:label-text"
 */

export type TemplateSource = "dembrane" | "user" | "suggestion";

export type TemplateRef = {
	source: TemplateSource;
	id: string;
};

const SEPARATOR = ":";

export function encodeTemplateKey(
	source: TemplateSource,
	id: string,
): string {
	return `${source}${SEPARATOR}${id}`;
}

export function decodeTemplateKey(key: string): TemplateRef | null {
	const idx = key.indexOf(SEPARATOR);
	if (idx === -1) return null;
	const source = key.slice(0, idx);
	const id = key.slice(idx + 1);
	if (source !== "dembrane" && source !== "user" && source !== "suggestion")
		return null;
	if (!id) return null;
	return { source: source as TemplateSource, id };
}

export function isDembraneKey(key: string): boolean {
	return key.startsWith("dembrane:");
}

export function isUserKey(key: string): boolean {
	return key.startsWith("user:");
}

export function isSuggestionKey(key: string): boolean {
	return key.startsWith("suggestion:");
}

/**
 * Convert a QuickAccessItem-style {type, id} to a canonical key.
 * "static" type maps to "dembrane" source.
 */
export function quickAccessToKey(
	type: "static" | "user",
	id: string,
): string {
	return encodeTemplateKey(type === "static" ? "dembrane" : "user", id);
}

/**
 * Convert a canonical key back to QuickAccessItem-style {type, id}.
 * Returns null if key is not a dembrane or user key.
 */
export function keyToQuickAccess(
	key: string,
): { type: "static" | "user"; id: string } | null {
	const ref = decodeTemplateKey(key);
	if (!ref || ref.source === "suggestion") return null;
	return {
		type: ref.source === "dembrane" ? "static" : "user",
		id: ref.id,
	};
}
