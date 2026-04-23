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
 * Resolve a workspace/team `logo_url` value → displayable URL.
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
