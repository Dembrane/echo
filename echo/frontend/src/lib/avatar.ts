import { DIRECTUS_PUBLIC_URL } from "@/config";

/**
 * Resolve a Directus file id → asset URL for <Avatar src={...}>.
 *
 * The backend hands us the raw `directus_users.avatar` column, which is
 * a file UUID, not a URL. Passing the UUID directly to <img src> silently
 * 404s and Mantine falls back to initials — which looks like "avatars
 * aren't showing" rather than "we forgot to build the URL." This helper
 * exists so no one has to remember the prefix.
 */
export function avatarUrl(
	fileId: string | null | undefined,
	size = 64,
): string | undefined {
	if (!fileId) return undefined;
	return `${DIRECTUS_PUBLIC_URL}/assets/${fileId}?width=${size}&height=${size}&fit=cover`;
}

/**
 * Resolve a workspace/organisation `logo_url` value → displayable URL.
 *
 * The column can hold two shapes:
 *   - Bare Directus file_id (new upload endpoint writes this)
 *   - Absolute http(s) URL (legacy rows, or pasted-in external logos)
 *
 * Return undefined for empty values so callers can fall through to an
 * initials avatar instead of rendering a broken image.
 */
export function logoUrl(
	value: string | null | undefined,
): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (trimmed === "") return undefined;
	if (trimmed.toLowerCase().startsWith("http://") || trimmed.toLowerCase().startsWith("https://")) {
		return trimmed;
	}
	return `${DIRECTUS_PUBLIC_URL}/assets/${trimmed}`;
}

/**
 * Canonical initials used inside <Avatar> circles on Members surfaces.
 *
 * One rule everywhere: first letter of the first name + first letter of
 * the last name. A single-token name yields one letter. No display name?
 * Fall back to the first two letters of the email. No email either?
 * "?".
 *
 * Prior code split every call site: some took `.slice(0, 2)` (gave "SA"
 * for "Sameer"), some took `.charAt(0)` (gave just "S"). The mix made
 * avatars look inconsistent row-to-row.
 */
export function memberInitials(
	displayName: string | null | undefined,
	email?: string | null,
): string {
	const name = (displayName || "").trim();
	if (name) {
		const tokens = name.split(/\s+/).filter(Boolean);
		if (tokens.length >= 2) {
			return (tokens[0][0] + tokens[tokens.length - 1][0]).toUpperCase();
		}
		if (tokens.length === 1) {
			return tokens[0][0].toUpperCase();
		}
	}
	const mail = (email || "").trim();
	if (mail) {
		return mail.slice(0, 2).toUpperCase();
	}
	return "?";
}
