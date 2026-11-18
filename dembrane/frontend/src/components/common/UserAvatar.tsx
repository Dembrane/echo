import { Avatar } from "@mantine/core";
import { useCurrentUser } from "@/components/auth/hooks";
import { avatarUrl as avatarSrc } from "@/lib/avatar";
import classes from "./UserAvatar.module.css";

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
	return (
		<PersonAvatar
			size={size}
			person={{
				avatar: user?.avatar as string | null,
				first_name: user?.first_name as string | null | undefined,
				last_name: (user as { last_name?: string | null } | undefined)
					?.last_name,
			}}
		/>
	);
};

/**
 * Anyone's picture, not only the signed-in user's: their uploaded avatar, else their
 * initials (from the name, else the email). Dimmed draws it faded, for someone invited
 * who has not joined yet. From 28px up, initials are set at the smallest text size rather
 * than Mantine's smaller default.
 */
export const PersonAvatar = ({
	person,
	size = 32,
	dimmed = false,
}: {
	person: {
		avatar?: string | null;
		name?: string | null;
		email?: string | null;
		first_name?: string | null;
		last_name?: string | null;
	};
	size?: number;
	dimmed?: boolean;
}) => {
	const initials =
		person.first_name || person.last_name
			? deriveInitials(person.first_name, person.last_name)
			: person.name?.trim()
				? deriveInitials(person.name)
				: deriveInitials(person.email);
	return (
		<Avatar
			src={avatarSrc(person.avatar, size * 2) ?? null}
			size={size}
			radius="50%"
			color="primary"
			className="shrink-0"
			classNames={size >= 28 ? { placeholder: classes.initials } : undefined}
			data-dimmed={dimmed || undefined}
		>
			{initials}
		</Avatar>
	);
};
