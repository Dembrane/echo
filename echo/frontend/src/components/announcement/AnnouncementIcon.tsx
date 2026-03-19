import { ActionIcon, Box, Group, Indicator, Loader, Text } from "@mantine/core";
import { FlagBannerIcon } from "@phosphor-icons/react";
import { useAnnouncementDrawer } from "@/components/announcement/hooks";
import { getTranslatedContent } from "@/components/announcement/hooks/useProcessedAnnouncements";
import { useLanguage } from "@/hooks/useLanguage";
import { testId } from "@/lib/testUtils";
import { useLatestAnnouncement, useUnreadAnnouncements } from "./hooks";

export const AnnouncementIcon = () => {
	const { open } = useAnnouncementDrawer();
	const { language } = useLanguage();
	const { data: latestAnnouncement, isLoading: isLoadingLatest } =
		useLatestAnnouncement();
	const { data: unreadCount, isLoading: isLoadingUnread } =
		useUnreadAnnouncements();

	const title = latestAnnouncement
		? getTranslatedContent(latestAnnouncement as Announcement, language).title
		: "";

	const isUnread = latestAnnouncement
		? !latestAnnouncement.activity?.some(
				(activity: AnnouncementActivity) => activity.read === true,
			)
		: false;

	const showPreview =
		isUnread && title && latestAnnouncement?.level === "info";

	const isLoading = isLoadingLatest || isLoadingUnread;

	return (
		<Group
			onClick={open}
			gap="sm"
			align="center"
			className="cursor-pointer"
			{...testId("announcement-icon-button")}
		>
			<Box>
				<Indicator
					inline
					offset={4}
					color="primary"
					label={
						<Box px={2} className="text-xs">
							{unreadCount || 0}
						</Box>
					}
					size={20}
					disabled={(unreadCount || 0) === 0}
					withBorder
				>
					<ActionIcon variant="transparent">
						{isLoading ? (
							<Loader size="xs" />
						) : (
							<FlagBannerIcon
								size={24}
								className="me-1"
								color="var(--app-text)"
								{...testId("announcement-speakerphone-icon")}
							/>
						)}
					</ActionIcon>
				</Indicator>
			</Box>

			{showPreview && (
				<Box
					className="hidden max-w-xs [mask-image:linear-gradient(to_right,black_80%,transparent)] md:block"
					style={{ maxWidth: "400px" }}
					{...testId("announcement-preview-message")}
				>
					<Text size="sm" className="line-clamp-1">
						{title}
					</Text>
				</Box>
			)}
		</Group>
	);
};
