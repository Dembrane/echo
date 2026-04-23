import { Avatar } from "@mantine/core";
import { useCurrentUser } from "@/components/auth/hooks";
import { DIRECTUS_PUBLIC_URL } from "@/config";

type UserAvatarProps = {
	size?: number;
};

/**
 * Initials from "First Last" style names: first letter of each of the
 * first two space-separated tokens ("Anna Bakker" → "AB"). Falls back
 * to the first two characters of the first name, and finally "?" when
 * the user hasn't filled either out. Fixes the AN / SS bug where a
 * single first_name was sliced to its first two letters.
 */
const deriveInitials = (
	firstName: string | null | undefined,
	lastName?: string | null,
): string => {
	const fn = (firstName ?? "").trim();
	const ln = (lastName ?? "").trim();
	if (fn && ln) {
		return `${fn[0]}${ln[0]}`.toUpperCase();
	}
	if (fn) {
		// Handle "Anna Bakker" coming through as a single first_name field.
		const parts = fn.split(/\s+/).filter(Boolean);
		if (parts.length >= 2) {
			return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
		}
		return fn.slice(0, 1).toUpperCase();
	}
	return "?";
};

export const UserAvatar = ({ size = 32 }: UserAvatarProps) => {
	const { data: user } = useCurrentUser();

	const avatarFileId = user?.avatar as string | null;
	const avatarUrl = avatarFileId
		? `${DIRECTUS_PUBLIC_URL}/assets/${avatarFileId}?width=${size * 2}&height=${size * 2}&fit=cover`
		: null;
	const initials = deriveInitials(
		user?.first_name as string | null | undefined,
		(user as { last_name?: string | null } | undefined)?.last_name,
	);

	return (
		<Avatar
			src={avatarUrl}
			size={size}
			radius="50%"
			color="blue"
			className="shrink-0"
		>
			{initials}
		</Avatar>
	);
};
