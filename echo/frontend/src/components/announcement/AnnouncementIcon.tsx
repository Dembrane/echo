import { ActionIcon, Box, Group, Indicator, Loader } from "@mantine/core";
import { IconSpeakerphone } from "@tabler/icons-react";
import { useAnnouncementDrawer } from "@/components/announcement/hooks";
import { getTranslatedContent } from "@/components/announcement/hooks/useProcessedAnnouncements";
import { Markdown } from "@/components/common/Markdown";
import { useLanguage } from "@/hooks/useLanguage";
import { useLatestAnnouncement, useUnreadAnnouncements } from "./hooks";

export const AnnouncementIcon = () => {
	const { open } = useAnnouncementDrawer();
	const { language } = useLanguage();
	const { data: latestAnnouncement, isLoading: isLoadingLatest } =
		useLatestAnnouncement();
	const { data: unreadCount, isLoading: isLoadingUnread } =
		useUnreadAnnouncements();

	// Get latest urgent announcement message
	const message = latestAnnouncement
		? getTranslatedContent(latestAnnouncement as Announcement, language).message
		: "";

	// Check if the latest announcement is unread
	const isUnread = latestAnnouncement
		? !latestAnnouncement.activity?.some(
				(activity: AnnouncementActivity) => activity.read === true,
			)
		: false;

	const showMessage =
		isUnread && message && latestAnnouncement?.level === "info";

	const isLoading = isLoadingLatest || isLoadingUnread;

	return (
		<Group onClick={open} gap="sm" align="center" className="cursor-pointer">
			<Box>
				<Indicator
					inline
					offset={4}
					color="blue"
					label={
						<Box px={2} className="text-xs">
							{unreadCount || 0}
						</Box>
					}
					size={20}
					disabled={(unreadCount || 0) === 0}
					withBorder
				>
					<ActionIcon color="gray" variant="transparent">
						{isLoading ? (
							<Loader size="xs" />
						) : (
							<IconSpeakerphone className="me-1 rotate-[330deg]" />
						)}
					</ActionIcon>
				</Indicator>
			</Box>

			{showMessage && (
				<Box
					className="hidden max-w-xs [mask-image:linear-gradient(to_right,black_80%,transparent)] md:block"
					style={{ maxWidth: "400px" }}
				>
					<Markdown content={message} className="line-clamp-1" />
				</Box>
			)}
		</Group>
	);
};
