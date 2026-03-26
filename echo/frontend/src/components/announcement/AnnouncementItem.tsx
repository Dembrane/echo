import { Trans } from "@lingui/react/macro";
import {
	Box,
	Button,
	Group,
	Stack,
	Text,
	ThemeIcon,
	useMantineTheme,
} from "@mantine/core";
import {
	CaretDown,
	CaretUp,
	Info,
	WarningCircle,
} from "@phosphor-icons/react";
import { forwardRef, useEffect, useRef, useState } from "react";
import { Markdown } from "@/components/common/Markdown";
import { testId } from "@/lib/testUtils";
import { useFormatDate } from "./utils/dateUtils";

type Announcement = {
	id: string;
	title: string;
	message: string;
	created_at: string | Date | null | undefined;
	expires_at?: string | Date | null | undefined;
	read?: boolean | null;
	level: "info" | "urgent";
};

interface AnnouncementItemProps {
	announcement: Announcement;
	index: number;
}

export const AnnouncementItem = forwardRef<
	HTMLDivElement,
	AnnouncementItemProps
>(({ announcement, index }, ref) => {
	const theme = useMantineTheme();
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

	return (
		<Box
			ref={ref}
			className={`group border-b border-gray-100 p-4 transition-all duration-200 hover:bg-blue-50 ${index === 0 ? "border-t-0" : ""} ${
				!announcement.read
					? "border-l-4 border-l-blue-500"
					: "border-l-4 border-l-gray-50/50 bg-gray-50/50"
			}`}
			{...testId(`announcement-item-${announcement.id}`)}
		>
			<Stack gap="xs">
				<Group gap="sm" align="flex-start">
					<ThemeIcon
						size={25}
						variant="light"
						color={announcement.level === "urgent" ? "orange" : "blue"}
						radius="xl"
					>
						{announcement.level === "urgent" ? (
							<WarningCircle size={17} weight="fill" />
						) : (
							<Info size={20} weight="fill" />
						)}
					</ThemeIcon>
					<Stack gap="xs" style={{ flex: 1 }}>
						<Group justify="space-between" align="center">
							<div style={{ flex: 1 }}>
								<Text size="sm" fw={500}>
									{announcement.title}
								</Text>
							</div>

							<Group gap="sm" align="center">
								<Text size="xs" c="dimmed">
									{formatDate(announcement.created_at)}
								</Text>

								{!announcement.read && (
									<div
										style={{
											backgroundColor: theme.colors.blue[6],
											borderRadius: "50%",
											height: 8,
											width: 8,
										}}
										{...testId("announcement-unread-indicator")}
									/>
								)}
							</Group>
						</Group>

						<Text lineClamp={showMore ? undefined : 2} ref={messageRef}>
							<Markdown
								content={announcement.message}
								className="text-sm text-gray-600"
							/>
						</Text>

						{showReadMoreButton && (
							<Group justify="flex-start">
								<Button
									variant="transparent"
									color="gray"
									size="xs"
									className="hover:underline"
									p={0}
									onClick={() => setShowMore(!showMore)}
									{...testId("announcement-show-more-button")}
								>
									{showMore ? (
										<Group gap="xs">
											<Trans>Show less</Trans>
											<CaretUp size={14} />
										</Group>
									) : (
										<Group gap="xs">
											<Trans>Show more</Trans>
											<CaretDown size={14} />
										</Group>
									)}
								</Button>
							</Group>
						)}
					</Stack>
				</Group>
			</Stack>
		</Box>
	);
});

AnnouncementItem.displayName = "AnnouncementItem";
