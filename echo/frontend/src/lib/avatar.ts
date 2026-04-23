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
