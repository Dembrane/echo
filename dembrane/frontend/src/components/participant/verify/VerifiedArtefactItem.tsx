import { Box, Group, Paper, Text } from "@mantine/core";
import { SealCheckIcon } from "@phosphor-icons/react";
import { format } from "date-fns";
import type { VerificationArtifact } from "@/lib/api";
import { testId } from "@/lib/testUtils";

type VerifiedArtefactItemProps = {
	artefact: VerificationArtifact;
	label: string;

	onViewArtefact: (artefactId: string) => void;
	dataTestId?: string;
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
	label,
	onViewArtefact,
	dataTestId,
}: VerifiedArtefactItemProps) => {
	// Format the timestamp using date-fns
	const formattedDate = formatArtefactTime(artefact.approved_at);

	return (
		<Box className="flex items-baseline justify-end">
			<Paper
				component="button"
				type="button"
				className="my-2 p-4"
				onClick={() => onViewArtefact(artefact.id)}
				{...(dataTestId ? testId(dataTestId) : {})}
			>
				<Group gap="sm" wrap="nowrap">
					<Group align="baseline">
						<Text size="sm">{label}</Text>
						{formattedDate && (
							<Text size="xs" c="dimmed">
								{formattedDate}
							</Text>
						)}
					</Group>
					<SealCheckIcon size={16} color="var(--app-action)" aria-hidden />
				</Group>
			</Paper>
		</Box>
	);
};
