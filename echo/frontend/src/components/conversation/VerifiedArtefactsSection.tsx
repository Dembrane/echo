import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Accordion,
	ActionIcon,
	Group,
	Skeleton,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { IconRosetteDiscountCheckFilled } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Markdown } from "@/components/common/Markdown";
import { getVerificationArtefacts } from "@/lib/api";

type VerifiedArtefactsSectionProps = {
	conversationId: string;
};

const formatArtefactTime = (timestamp: string | null | undefined): string => {
	if (!timestamp) return "";

	try {
		return format(new Date(timestamp), "MMM d, yyyy 'at' h:mm a");
	} catch {
		return "";
	}
};

export const VerifiedArtefactsSection = ({
	conversationId,
}: VerifiedArtefactsSectionProps) => {
	// Fetch all artefacts with content for display
	const { data: artefacts, isLoading } = useQuery({
		enabled: !!conversationId,
		queryFn: () => getVerificationArtefacts(conversationId),
		queryKey: ["verify", "conversation_artifacts", conversationId],
	});

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
				<ActionIcon
					variant="subtle"
					color="blue"
					aria-label={t`artefacts`}
					size={22}
				>
					<IconRosetteDiscountCheckFilled />
				</ActionIcon>
			</Group>

			<Accordion variant="unstyled" radius="md">
				{artefacts.map((artefact) => {
					const formattedDate = formatArtefactTime(artefact.approved_at);

					return (
						<Accordion.Item key={artefact.id} value={artefact.id}>
							<Accordion.Control>
								<Group gap="sm" wrap="nowrap">
									<Stack gap={2}>
										<Text fw={500}>{artefact.key || ""}</Text>
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
