import {
	ActionIcon,
	Box,
	Group,
	ThemeIcon,
	useMantineTheme,
} from "@mantine/core";
import { IconAlertTriangle, IconX } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useAnnouncementDrawer } from "@/components/announcement/hooks";
import { getTranslatedContent } from "@/components/announcement/hooks/useProcessedAnnouncements";
import { Markdown } from "@/components/common/Markdown";
import { useLanguage } from "@/hooks/useLanguage";
import { useLatestAnnouncement, useMarkAsReadMutation } from "./hooks";

export function TopAnnouncementBar() {
	const theme = useMantineTheme();
	const { data: announcement, isLoading } = useLatestAnnouncement();
	const markAsReadMutation = useMarkAsReadMutation();
	const [isClosed, setIsClosed] = useState(false);
	const { open } = useAnnouncementDrawer();
	const { language } = useLanguage();

	// Check if the announcement has been read by the current user
	// Directus already filters activity data for the current user
	const isRead = announcement?.activity?.some(
		(activity: AnnouncementActivity) => activity.read === true,
	);

	useEffect(() => {
		const shouldUseDefaultHeight =
			isLoading ||
			!announcement ||
			announcement.level !== "urgent" ||
			isClosed ||
			isRead;

		const height = shouldUseDefaultHeight ? "60px" : "112px";
		const root = document.documentElement.style;

		root.setProperty(
			"--base-layout-height",
			`calc(100% - ${height})`,
			"important",
		);
		root.setProperty("--base-layout-padding", height, "important");
		root.setProperty(
			"--project-layout-height",
			`calc(100vh - ${height})`,
			"important",
		);
	}, [isLoading, announcement, isClosed, isRead]);

	// Only show if we have an urgent announcement, it's not closed, and it's not read
	if (
		isLoading ||
		!announcement ||
		announcement.level !== "urgent" ||
		isClosed ||
		isRead
	) {
		return null;
	}

	const { title } = getTranslatedContent(
		announcement as Announcement,
		language,
	);

	const handleClose = async (e: React.MouseEvent) => {
		e.stopPropagation();
		setIsClosed(true);

		// Mark announcement as read
		if (announcement.id) {
			markAsReadMutation.mutate({
				announcementId: announcement.id,
			});
		}
	};

	const handleBarClick = () => {
		open();
	};

	return (
		<Box
			className="relative flex w-full cursor-pointer items-center justify-center px-4 py-3 text-center"
			bg={theme.colors.blue[0]}
			onClick={handleBarClick}
		>
			<Group justify="center" gap="md" wrap="nowrap" className="pr-9">
				<ThemeIcon
					size={25}
					variant="transparent"
					color={announcement.level === "urgent" ? "orange" : "blue"}
					radius="xl"
				>
					<IconAlertTriangle size={20} />
				</ThemeIcon>
				<Markdown content={title} className="line-clamp-1" />
			</Group>

			<ActionIcon
				variant="transparent"
				size="sm"
				onClick={handleClose}
				className="absolute right-6"
			>
				<IconX size={16} />
			</ActionIcon>
		</Box>
	);
}
