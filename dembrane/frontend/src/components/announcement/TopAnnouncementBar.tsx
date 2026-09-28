import {
	ActionIcon,
	Box,
	Group,
	Text,
	ThemeIcon,
} from "@mantine/core";
import { WarningCircle, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useAnnouncementDrawer } from "@/components/announcement/hooks";
import { getTranslatedContent } from "@/components/announcement/hooks/useProcessedAnnouncements";
import { useLanguage } from "@/hooks/useLanguage";
import { useLatestAnnouncement, useMarkAsReadMutation } from "./hooks";

export function TopAnnouncementBar() {
	const { data: announcement, isLoading } = useLatestAnnouncement();
	const markAsReadMutation = useMarkAsReadMutation();
	const [isClosed, setIsClosed] = useState(false);
	const { open } = useAnnouncementDrawer();
	const { language } = useLanguage();

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

		if (announcement.id) {
			markAsReadMutation.mutate({
				announcementId: announcement.id,
			});
		}
	};

	const handleBarClick = () => {
		open();
	};

	const bgColor =
		announcement.level === "urgent"
			? "rgba(255, 209, 102, 0.15)"
			: "var(--mantine-color-blue-0)";

	return (
		<Box
			className="relative flex w-full cursor-pointer items-center justify-center px-4 py-3 text-center border-b"
			bg={bgColor}
			onClick={handleBarClick}
		>
			<Group justify="center" gap="md" wrap="nowrap" className="pr-9">
				<ThemeIcon
					size={25}
					variant="transparent"
					color={announcement.level === "urgent" ? "orange" : "blue"}
					radius="xl"
				>
					<WarningCircle size={20} weight="fill" />
				</ThemeIcon>
				<Text size="sm" className="line-clamp-1">
					{title}
				</Text>
			</Group>

			<ActionIcon
				variant="transparent"
				size="sm"
				onClick={handleClose}
				className="absolute right-6"
			>
				<X size={16} />
			</ActionIcon>
		</Box>
	);
}
