import { Box, Skeleton, Stack } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useState } from "react";
import { ArtefactModal } from "./ArtefactModal";
import {
	useConversationArtefact,
	useConversationArtefacts,
	useVerificationTopics,
} from "./hooks";
import { TOPIC_ICON_MAP } from "./VerifySelection";
import { VerifiedArtefactItem } from "./VerifiedArtefactItem";

type VerifiedArtefactsListProps = {
	conversationId: string;
	projectId: string;
	projectLanguage?: string | null;
};

export const VerifiedArtefactsList = ({
	conversationId,
	projectId,
	projectLanguage,
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
	const topicsQuery = useVerificationTopics(projectId);

	const LANGUAGE_TO_LOCALE: Record<string, string> = {
		de: "de-DE",
		en: "en-US",
		es: "es-ES",
		fr: "fr-FR",
		nl: "nl-NL",
	};

	const locale =
		LANGUAGE_TO_LOCALE[projectLanguage ?? "en"] ?? LANGUAGE_TO_LOCALE.en;

	const availableTopics = topicsQuery.data?.available_topics ?? [];
	const topicMetadataMap = new Map(
		availableTopics.map((topic) => [
			topic.key,
			{
				label:
					topic.translations?.[locale]?.label ??
					topic.translations?.["en-US"]?.label ??
					topic.key,
				icon:
					TOPIC_ICON_MAP[topic.key] ??
					(topic.icon && !topic.icon.startsWith(":") ? topic.icon : undefined),
			},
		]),
	);

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
						label={topicMetadataMap.get(artefact.key)?.label ?? artefact.key}
						icon={topicMetadataMap.get(artefact.key)?.icon}
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
