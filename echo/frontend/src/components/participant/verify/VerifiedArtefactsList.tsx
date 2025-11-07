import { Box, Skeleton, Stack } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useState } from "react";
import { ArtefactModal } from "./ArtefactModal";
import { useConversationArtefact, useConversationArtefacts } from "./hooks";
import { VerifiedArtefactItem } from "./VerifiedArtefactItem";

type VerifiedArtefactsListProps = {
	conversationId: string;
};

export const VerifiedArtefactsList = ({
	conversationId,
}: VerifiedArtefactsListProps) => {
	const { data: artefacts, isLoading } =
		useConversationArtefacts(conversationId);
	const [opened, { open, close }] = useDisclosure(false);
	const [selectedArtefactId, setSelectedArtefactId] = useState<string | null>(
		null,
	);

	// Fetch the full artefact content when one is selected
	const { data: selectedArtefact, isLoading: isLoadingArtefact } =
		useConversationArtefact(selectedArtefactId ?? undefined);

	const handleViewArtefact = (artefactId: string) => {
		setSelectedArtefactId(artefactId);
		open();
	};

	const handleCloseModal = () => {
		close();
	};

	const handleModalExited = () => {
		setSelectedArtefactId(null);
	};

	if (isLoading) {
		return (
			<Stack gap="sm" align="flex-end">
				<Skeleton my={7} height={54} width="80%" radius="md" />
			</Stack>
		);
	}

	if (!artefacts || artefacts.length === 0) {
		return null;
	}

	return (
		<>
			<Box>
				{artefacts.map((artefact: ConversationArtefact) => (
					<VerifiedArtefactItem
						key={artefact.id}
						artefact={artefact}
						onViewArtefact={handleViewArtefact}
					/>
				))}
			</Box>
			<ArtefactModal
				opened={opened}
				onClose={handleCloseModal}
				onExited={handleModalExited}
				isLoading={isLoadingArtefact}
				artefact={selectedArtefact}
			/>
		</>
	);
};
