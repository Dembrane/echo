import { Trans } from "@lingui/react/macro";
import { Box, Button, Group, Stack, Text } from "@mantine/core";
import { CaretDown, CaretUp, Info, WarningCircle } from "@phosphor-icons/react";
import { forwardRef, useEffect, useRef, useState } from "react";
import { Markdown } from "@/components/common/Markdown";
import { testId } from "@/lib/testUtils";
import { useFormatDate } from "./utils/dateUtils";

type Announcement = {
	id: string;
	activityIds: string[];
	title: string;
	message: string;
	created_at: string | Date | null | undefined;
	expires_at?: string | Date | null | undefined;
	read?: boolean | null;
	level: "info" | "urgent";
};

interface AnnouncementItemProps {
	announcement: Announcement;
	onMarkAsRead: (id: string) => void;
	onMarkAsUnread: (id: string, activityIds: string[]) => void;
	index: number;
}

export const AnnouncementItem = forwardRef<
	HTMLDivElement,
	AnnouncementItemProps
>(({ announcement, onMarkAsRead, onMarkAsUnread, index }, ref) => {
	const [showMore, setShowMore] = useState(false);
	const [showReadMoreButton, setShowReadMoreButton] = useState(false);
	const messageRef = useRef<HTMLDivElement>(null);
	const formatDate = useFormatDate();

	useEffect(() => {
		if (messageRef.current) {
			setShowReadMoreButton(
				messageRef.current.scrollHeight !== messageRef.current.clientHeight,
			);
		}
	}, []);

	const isRead = !!announcement.read;

	return (
		<Box
			ref={ref}
			className="group"
			p="md"
			data-index={index}
			style={{ borderBottom: "1px solid var(--app-rule-color)" }}
			{...testId(`announcement-item-${announcement.id}`)}
		>
			<Stack gap="xs">
				<Group gap="sm" align="flex-start">
					{announcement.level === "urgent" ? (
						<WarningCircle
							size={20}
							color="var(--app-warning)"
							style={{ flexShrink: 0 }}
						/>
					) : (
						<Info
							size={20}
							color="var(--mantine-color-dimmed)"
							style={{ flexShrink: 0 }}
						/>
					)}
					<Stack gap="xs" style={{ flex: 1 }}>
						<Group justify="space-between" align="center">
							<div style={{ flex: 1 }}>
								<Text size="sm" c={isRead ? "dimmed" : undefined}>
									{announcement.title}
								</Text>
							</div>

							<Group gap="sm" align="center">
								<Text size="xs" c="dimmed">
									{formatDate(announcement.created_at)}
								</Text>

								{!isRead && (
									<div
										style={{
											backgroundColor: "var(--app-action)",
											borderRadius: "50%",
											height: 8,
											width: 8,
										}}
										{...testId("announcement-unread-indicator")}
									/>
								)}
							</Group>
						</Group>

						<Text
							size="sm"
							c="dimmed"
							lineClamp={showMore ? undefined : 2}
							ref={messageRef}
						>
							<Markdown content={announcement.message} className="text-sm" />
						</Text>

						<Group justify="space-between" align="center">
							{showReadMoreButton && (
								<Button
									variant="subtle"
									color="gray"
									size="xs"
									rightSection={
										showMore ? <CaretUp size={16} /> : <CaretDown size={16} />
									}
									onClick={() => setShowMore(!showMore)}
									{...testId("announcement-show-more-button")}
								>
									{showMore ? (
										<Trans>Show less</Trans>
									) : (
										<Trans>Show more</Trans>
									)}
								</Button>
							)}

							{isRead ? (
								<Button
									variant="subtle"
									size="xs"
									color="gray"
									ml="auto"
									onClick={() =>
										onMarkAsUnread(announcement.id, announcement.activityIds)
									}
									{...testId("announcement-mark-as-unread-button")}
								>
									<Trans>Mark as unread</Trans>
								</Button>
							) : (
								<Button
									variant="subtle"
									size="xs"
									color="gray"
									ml="auto"
									onClick={() => onMarkAsRead(announcement.id)}
									{...testId("announcement-mark-as-read-button")}
								>
									<Trans>Mark as read</Trans>
								</Button>
							)}
						</Group>
					</Stack>
				</Group>
			</Stack>
		</Box>
	);
});

AnnouncementItem.displayName = "AnnouncementItem";
