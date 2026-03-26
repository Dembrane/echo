import { Avatar } from "@mantine/core";
import { useCurrentUser } from "@/components/auth/hooks";
import { DIRECTUS_PUBLIC_URL } from "@/config";

type UserAvatarProps = {
	size?: number;
};

export const UserAvatar = ({ size = 32 }: UserAvatarProps) => {
	const { data: user } = useCurrentUser();

	const avatarFileId = user?.avatar as string | null;
	const avatarUrl = avatarFileId
		? `${DIRECTUS_PUBLIC_URL}/assets/${avatarFileId}?width=${size * 2}&height=${size * 2}&fit=cover`
		: null;
	const initials =
		(user?.first_name as string)?.slice(0, 2)?.toUpperCase() ?? "?";

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
