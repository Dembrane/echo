import { t } from "@lingui/core/macro";
import { ActionIcon, Alert, Group, Text } from "@mantine/core";
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

	// Only urgent announcements reach the bar (see the guard above), so it
	// is the yellow status alert.
	return (
		<Alert
			color="yellow"
			variant="light"
			py="xs"
			px="md"
			icon={<WarningCircle size={20} />}
			onClick={handleBarClick}
			style={{ cursor: "pointer", width: "100%" }}
			styles={{ icon: { alignSelf: "center" } }}
		>
			<Group justify="space-between" gap="md" wrap="nowrap">
				<Text size="sm" lineClamp={1}>
					{title}
				</Text>
				<ActionIcon
					variant="subtle"
					color="gray"
					onClick={handleClose}
					aria-label={t`Dismiss`}
				>
					<X size={20} />
				</ActionIcon>
			</Group>
		</Alert>
	);
}
