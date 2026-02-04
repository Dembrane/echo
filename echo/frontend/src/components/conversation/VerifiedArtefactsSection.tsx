import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Accordion,
	Group,
	Skeleton,
	Stack,
	Text,
	ThemeIcon,
	Title,
} from "@mantine/core";
import { IconRosetteDiscountCheck } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Markdown } from "@/components/common/Markdown";
import { useVerificationTopics } from "@/components/participant/verify/hooks";
import { getVerificationArtefacts } from "@/lib/api";
import { testId } from "@/lib/testUtils";

type VerifiedArtefactsSectionProps = {
	conversationId: string;
	projectId: string;
	projectLanguage?: string | null;
};

const formatArtefactTime = (timestamp: string | null | undefined): string => {
	if (!timestamp) return "";

	try {
		return format(new Date(timestamp), "MMM d, yyyy 'at' h:mm a");
	} catch {
		return "";
	}
};

const LANGUAGE_TO_LOCALE: Record<string, string> = {
	de: "de-DE",
	en: "en-US",
	es: "es-ES",
	fr: "fr-FR",
	it: "it-IT",
	nl: "nl-NL",
};

export const VerifiedArtefactsSection = ({
	conversationId,
	projectId,
	projectLanguage,
}: VerifiedArtefactsSectionProps) => {
	// Fetch all artefacts with content for display
	const { data: artefacts, isLoading } = useQuery({
		enabled: !!conversationId,
		queryFn: () => getVerificationArtefacts(conversationId),
		queryKey: ["verify", "conversation_artifacts", conversationId],
	});

	const topicsQuery = useVerificationTopics(projectId);
	const locale =
		LANGUAGE_TO_LOCALE[projectLanguage ?? "en"] ?? LANGUAGE_TO_LOCALE.en;

	const availableTopics = topicsQuery.data?.available_topics ?? [];
	const topicLabelMap = new Map(
		availableTopics.map((topic) => [
			topic.key,
			topic.translations?.[locale]?.label ??
				topic.translations?.["en-US"]?.label ??
				topic.key,
		]),
	);

	if (isLoading) {
		return (
			<Stack gap="sm">
				<Skeleton height={60} width="50%" radius="md" />
				<Skeleton height={60} width="50%" radius="md" />
			</Stack>
		);
	}

	// Don't show the section if there are no artefacts
	if (!artefacts || artefacts.length === 0) {
		return null;
	}

	return (
		<Stack gap="1.5rem">
			<Group>
				<Title order={2}>
					<Trans>Artefacts</Trans>
				</Title>
				<ThemeIcon
					variant="subtle"
					color="primary"
					aria-label={t`artefacts`}
					size={22}
				>
					<IconRosetteDiscountCheck />
				</ThemeIcon>
			</Group>

			<Accordion
				variant="unstyled"
				radius="md"
				{...testId("conversation-artefacts-accordion")}
			>
				{artefacts.map((artefact) => {
					const formattedDate = formatArtefactTime(artefact.approved_at);

					return (
						<Accordion.Item
							key={artefact.id}
							value={artefact.id}
							{...testId(`conversation-artefact-item-${artefact.id}`)}
						>
							<Accordion.Control>
								<Group gap="sm" wrap="nowrap">
									<Stack gap={2}>
										<Text fw={500}>
											{topicLabelMap.get(artefact.key) ?? artefact.key ?? ""}
										</Text>
										{formattedDate && (
											<Text size="xs" c="dimmed">
												<Trans id="conversation.verified.approved">
													Approved
												</Trans>{" "}
												{formattedDate}
											</Text>
										)}
									</Stack>
								</Group>
							</Accordion.Control>
							<Accordion.Panel>
								<Markdown content={artefact.content ?? ""} />
							</Accordion.Panel>
						</Accordion.Item>
					);
				})}
			</Accordion>
		</Stack>
	);
};
