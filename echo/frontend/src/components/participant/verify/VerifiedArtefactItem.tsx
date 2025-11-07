import { t } from "@lingui/core/macro";
import { ActionIcon, Box, Group, Paper, Text } from "@mantine/core";
import { IconRosetteDiscountCheckFilled } from "@tabler/icons-react";
import { format } from "date-fns";
import { VERIFY_OPTIONS } from "./VerifySelection";

type VerifiedArtefactItemProps = {
	artefact: ConversationArtefact;
	onViewArtefact: (artefactId: string) => void;
};

const formatArtefactTime = (timestamp: string | null | undefined): string => {
	if (!timestamp) return "";

	try {
		return format(new Date(timestamp), "h:mm a");
	} catch {
		return "";
	}
};

export const VerifiedArtefactItem = ({
	artefact,
	onViewArtefact,
}: VerifiedArtefactItemProps) => {
	// Get the label from the key
	const option = VERIFY_OPTIONS.find((opt) => opt.key === artefact.key);
	const label = option?.label || artefact.key;

	// Format the timestamp using date-fns
	const formattedDate = formatArtefactTime(artefact.approved_at);

	return (
		<Box className="flex items-baseline justify-end">
			<Paper
				className="my-2 cursor-pointer rounded-t-xl rounded-bl-xl p-4 hover:bg-gray-50 transition-colors"
				onClick={() => onViewArtefact(artefact.id)}
			>
				<Group gap="sm" wrap="nowrap">
					<ActionIcon
						variant="subtle"
						color="blue"
						aria-label={t`verified artefact`}
						size={22}
					>
						<IconRosetteDiscountCheckFilled />
					</ActionIcon>
					<Group align="baseline">
						<Text className="prose text-sm">{label}</Text>
						{formattedDate && (
							<Text size="xs" c="dimmed">
								{formattedDate}
							</Text>
						)}
					</Group>
				</Group>
			</Paper>
		</Box>
	);
};
