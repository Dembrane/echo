import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Box,
	Button,
	Modal,
	NativeSelect,
	Stack,
	Text,
} from "@mantine/core";
import { MessageCircleIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { useProjectConversationCounts } from "@/components/report/hooks";
import { useLanguage } from "@/hooks/useLanguage";
import { CloseableAlert } from "../common/ClosableAlert";
import { ExponentialProgress } from "../common/ExponentialProgress";
import { languageOptionsByIso639_1 } from "../language/LanguagePicker";
import { ConversationStatusTable } from "./ConversationStatusTable";
import { useCreateProjectReportMutation } from "./hooks";

export const CreateReportForm = ({ onSuccess }: { onSuccess: () => void }) => {
	const {
		mutate,
		isPending,
		data: report,
		error,
	} = useCreateProjectReportMutation();
	const { projectId } = useParams<{ projectId: string }>();
	const { data: conversationCounts } = useProjectConversationCounts(
		projectId ?? "",
	);
	const { iso639_1 } = useLanguage();
	const [language, setLanguage] = useState(iso639_1);
	const [modalOpened, setModalOpened] = useState(false);

	const hasConversations = conversationCounts && conversationCounts.total > 0;
	const hasFinishedConversations =
		conversationCounts && conversationCounts.finished > 0;

	useEffect(() => {
		if (report) {
			onSuccess();
		}
	}, [report, onSuccess]);

	if (isPending) {
		return (
			<Stack>
				<Alert title={t`Processing your report...`} mt={12}>
					<Trans>
						Please wait while we generate your report. You will automatically be
						redirected to the report page.
					</Trans>
				</Alert>
				<ExponentialProgress expectedDuration={250} isLoading={true} />
			</Stack>
		);
	}

	if (error) {
		return (
			<Alert title={t`Error creating report`} color="red" mt={12}>
				<Trans>
					There was an error creating your report. Please try again or contact
					support.
				</Trans>
			</Alert>
		);
	}

	return (
		<Stack maw="500px" className="pt-4">
			{/* Inform the user about conversation processing status */}

			{/* Conversation Status Section */}
			{hasConversations ? (
				<CloseableAlert title={t`Welcome to Reports!`}>
					<Trans>Generate insights from your conversations</Trans>
				</CloseableAlert>
			) : (
				/* No conversations message */
				<Box mb="xl" px="sm" mt="xl">
					<Stack gap={8} align="center">
						<MessageCircleIcon className="h-10 w-10" color="darkgray" />
						<Text size="sm" c="gray.9" ta="center" fw={500}>
							<Trans>No conversations yet</Trans>
						</Text>
						<Text size="sm" c="gray.6" ta="center">
							<Trans>
								To generate a report, please start by adding conversations in
								your project
							</Trans>
						</Text>
					</Stack>
				</Box>
			)}
			{/* Detailed Conversation Modal */}
			{hasConversations && (
				<>
					<Stack gap={0} mb="sm">
						<Text size="sm" c="gray.6" my="sm">
							<Text
								span
								component="a"
								c="blue.7"
								href="#"
								fw={500}
								onClick={(e) => {
									e.preventDefault();
									setModalOpened(true);
								}}
								className="cursor-pointer underline-offset-4 hover:underline"
							>
								{conversationCounts.total ?? 0} <Trans>
									conversations
								</Trans>{" "}
							</Text>
							<Trans>will be included in your report</Trans>
						</Text>
					</Stack>

					<Modal
						opened={modalOpened}
						onClose={() => setModalOpened(false)}
						title={<Trans>Conversation Status Details</Trans>}
						size="lg"
						centered
					>
						<ConversationStatusTable projectId={projectId ?? ""} />
					</Modal>
				</>
			)}

			{hasFinishedConversations && (
				<NativeSelect
					value={language}
					label={
						<Box pb="xs">
							<Trans>Please select a language for your report</Trans>
						</Box>
					}
					onChange={(e) => setLanguage(e.target.value)}
					data={languageOptionsByIso639_1}
				/>
			)}

			<Button
				onClick={() =>
					mutate({
						language: language,
						projectId: projectId ?? "",
					})
				}
				loading={isPending}
				disabled={isPending || !hasConversations || !hasFinishedConversations}
				size="md"
				mt="xs"
			>
				<Trans>Create Report</Trans>
			</Button>
		</Stack>
	);
};
