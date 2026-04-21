import {
	Box,
	Collapse,
	Group,
	Stack,
	Text,
	ThemeIcon,
	UnstyledButton,
} from "@mantine/core";
import { CaretDown, CaretRight, Sparkle } from "@phosphor-icons/react";
import { useState } from "react";
import { Markdown } from "@/components/common/Markdown";
import { testId } from "@/lib/testUtils";
import type { ProcessedAnnouncement } from "./hooks/useProcessedAnnouncements";
import { useFormatDate } from "./utils/dateUtils";

interface WhatsNewItemProps {
	announcement: ProcessedAnnouncement;
}

export const WhatsNewItem = ({ announcement }: WhatsNewItemProps) => {
	const [expanded, setExpanded] = useState(false);
	const formatDate = useFormatDate();

	return (
		<Box
			className="border-b border-gray-100 px-4 py-3 transition-all duration-200 hover:bg-blue-50"
			{...testId(`whats-new-item-${announcement.id}`)}
		>
			<UnstyledButton
				onClick={() => setExpanded(!expanded)}
				w="100%"
			>
				<Group gap="sm" align="center" wrap="nowrap">
					{expanded ? (
						<CaretDown size={14} color="#4169e1" />
					) : (
						<CaretRight size={14} color="#4169e1" />
					)}
					<ThemeIcon
						size={25}
						variant="light"
						color="blue"
						radius="xl"
					>
						<Sparkle size={16} weight="fill" color="#4169e1" />
					</ThemeIcon>
					<Text size="sm" fw={500} style={{ flex: 1 }}>
						{announcement.title}
					</Text>
					<Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
						{formatDate(announcement.created_at)}
					</Text>
				</Group>
			</UnstyledButton>

			<Collapse in={expanded}>
				<Box pl={37} pt="xs">
					<Markdown
						content={announcement.message}
						className="text-sm text-gray-600"
					/>
				</Box>
			</Collapse>
		</Box>
	);
};
