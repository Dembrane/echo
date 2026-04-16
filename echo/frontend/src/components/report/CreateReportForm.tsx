import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Anchor,
	Badge,
	Box,
	Button,
	Divider,
	Group,
	Modal,
	NativeSelect,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import { usePostHog } from "@posthog/react";
import {
	IconArrowLeft,
	IconClock,
	IconExternalLink,
} from "@tabler/icons-react";
import { AxiosError } from "axios";
import { MessageCircleIcon } from "lucide-react";
import { useState } from "react";
import { useParams } from "react-router";
import { useProjectConversationCounts } from "@/components/report/hooks";
import { getProductFeedbackUrl } from "@/config";
import focusOptionsData from "@/data/reportFocusOptions.json";
import { useLanguage } from "@/hooks/useLanguage";
import { testId } from "@/lib/testUtils";
import { CloseableAlert } from "../common/ClosableAlert";
import { languageOptionsByIso639_1 } from "../language/LanguagePicker";
import { ConversationStatusTable } from "./ConversationStatusTable";
import { useCreateProjectReportMutation } from "./hooks";
import { ReportFocusSelector } from "./ReportFocusSelector";
import {
	isDateFarEnough,
	ScheduleDateTimePicker,
} from "./ScheduleDateTimePicker";

function getLanguageLabel(iso: string): string {
	return languageOptionsByIso639_1.find((o) => o.value === iso)?.label ?? iso;
}

function getSelectedFocusLabels(
	instructions: string,
	language: string,
): string[] {
	return focusOptionsData.options
		.filter((opt) => instructions.includes(opt.instruction))
		.map(
			(opt) =>
				(opt.labels as Record<string, string>)[language] ?? opt.labels.en,
		);
}

function getCustomFocusText(instructions: string): string {
	let remaining = instructions;
	for (const opt of focusOptionsData.options) {
		remaining = remaining.replace(opt.instruction, "");
	}
	return remaining.replace(/\n{2,}/g, "\n").trim();
}

// Feature flag: show "custom report structure" CTA until 2026-05-11
const SHOW_STRUCTURE_CTA =
	Date.now() < new Date("2026-05-11T00:00:00Z").getTime();

export const CreateReportForm = ({ onSuccess }: { onSuccess: () => void }) => {
	const { mutate, isPending, error } = useCreateProjectReportMutation();
	const { projectId } = useParams<{ projectId: string }>();
	const { data: conversationCounts } = useProjectConversationCounts(
		projectId ?? "",
	);
	const { iso639_1, language: appLocale } = useLanguage();
	const [language, setLanguage] = useState(iso639_1);
	const [userInstructions, setUserInstructions] = useState("");
	const [detailModalOpened, setDetailModalOpened] = useState(false);
	const [showSchedule, setShowSchedule] = useState(false);
	const [scheduledDate, setScheduledDate] = useState<Date | null>(null);
	const posthog = usePostHog();

	const hasConversations = conversationCounts && conversationCounts.total > 0;
	const hasFinishedConversations =
		conversationCounts && conversationCounts.finished > 0;
	const conversationTotal = conversationCounts?.total ?? 0;

	const is409Error =
		error instanceof AxiosError && error.response?.status === 409;

	const handleCreate = (schedule?: boolean) => {
		posthog?.capture("report_generated", {
			has_user_instructions: !!userInstructions,
			language,
			project_id: projectId,
			scheduled: !!schedule,
		});
		mutate(
			{
				language,
				projectId: projectId ?? "",
				scheduledAt:
					schedule && scheduledDate ? scheduledDate.toISOString() : undefined,
				userInstructions: userInstructions || undefined,
			},
			{
				onSuccess: () => onSuccess(),
			},
		);
	};

	if (error) {
		return (
			<Alert
				title={
					is409Error ? t`Report already generating` : t`Error creating report`
				}
				color={is409Error ? "yellow" : "red"}
				mt={12}
			>
				{is409Error ? (
					<Trans>
						A report is already being generated for this project. Please wait
						for it to complete.
					</Trans>
				) : (
					<Trans>
						There was an error creating your report. Please try again or contact
						support.
					</Trans>
				)}
			</Alert>
		);
	}

	return (
		<Stack maw="540px" className="pt-4">
			<CloseableAlert
				title={t`Generate a Report`}
				storageKey="create-report-info-dismissed"
			>
				{hasConversations ? (
					<Trans>
						It looks like you don't have a report for this project yet. Generate
						one to get an overview of your conversations.
					</Trans>
				) : (
					<Trans>
						No conversations yet. You can schedule a report now and
						conversations will be included once they are added.
					</Trans>
				)}
			</CloseableAlert>

			{hasConversations && (
				<>
					<Text size="sm" c="gray.6">
						<Text
							span
							component="a"
							c="blue.7"
							href="#"
							fw={500}
							onClick={(e) => {
								e.preventDefault();
								setDetailModalOpened(true);
							}}
							className="cursor-pointer underline-offset-4 hover:underline"
						>
							{conversationTotal} <Trans>conversations</Trans>{" "}
						</Text>
						<Trans>will be included in your report</Trans>
					</Text>

					<Modal
						opened={detailModalOpened}
						onClose={() => setDetailModalOpened(false)}
						title={<Trans>Conversation Status Details</Trans>}
						size="lg"
						centered
						{...testId("report-conversation-status-modal")}
					>
						<ConversationStatusTable projectId={projectId ?? ""} />
					</Modal>
				</>
			)}

			{hasConversations && !hasFinishedConversations ? (
				<Text size="sm" c="dimmed">
					<Trans>
						Waiting for conversations to finish before generating a report.
					</Trans>
				</Text>
			) : showSchedule ? (
				<Stack>
					<Group gap="xs" align="center">
						<Text fw={500} size="lg">
							<Trans>Schedule Report</Trans>
						</Text>
						<Badge color="mauve" c="graphite" size="sm">
							<Trans>Beta</Trans>
						</Badge>
					</Group>

					{/* Summary of selected options */}
					<Stack gap={4}>
						<Text size="xs" c="dimmed">
							<Trans>Language</Trans>: {getLanguageLabel(language)}
							{getSelectedFocusLabels(userInstructions, language).length >
								0 && (
								<>
									{" · "}
									<Trans>Focus</Trans>:{" "}
									{getSelectedFocusLabels(userInstructions, language).join(
										", ",
									)}
								</>
							)}
							{getCustomFocusText(userInstructions) && (
								<>
									{" · "}
									<Text span fs="italic" size="xs" c="dimmed">
										"
										{getCustomFocusText(userInstructions).length > 60
											? `${getCustomFocusText(userInstructions).slice(0, 60)}…`
											: getCustomFocusText(userInstructions)}
										"
									</Text>
								</>
							)}
						</Text>
						<Anchor
							size="xs"
							component="button"
							onClick={() => setShowSchedule(false)}
						>
							<Group gap={4}>
								<IconArrowLeft size={12} />
								<Trans>Edit options</Trans>
							</Group>
						</Anchor>
					</Stack>

					<ScheduleDateTimePicker
						label={t`When should the report be generated?`}
						value={scheduledDate}
						onChange={setScheduledDate}
					/>

					<Text size="xs" c="dimmed">
						<Trans>
							The report may start up to 5 minutes after the chosen time.
						</Trans>
					</Text>

					<Stack mt="xs" gap="xs">
						<Button
							onClick={() => handleCreate(true)}
							loading={isPending}
							disabled={isPending || !isDateFarEnough(scheduledDate)}
							fullWidth
							color="primary"
							{...testId("report-create-button")}
						>
							<Trans>Schedule Report</Trans>
						</Button>
						<Button
							variant="subtle"
							fullWidth
							onClick={() => setShowSchedule(false)}
						>
							<Trans>Generate now instead</Trans>
						</Button>
					</Stack>
				</Stack>
			) : (
				<Stack gap={0}>
					<Stack gap="md">
						<NativeSelect
							value={language}
							label={t`Language`}
							onChange={(e) => setLanguage(e.target.value)}
							data={languageOptionsByIso639_1}
							{...testId("report-language-select")}
						/>

						<ReportFocusSelector
							value={userInstructions}
							onChange={setUserInstructions}
							language={language}
						/>
					</Stack>

					<Group gap="xs" mt={24} wrap="wrap">
						<Tooltip
							label={t`Add conversations to your project first`}
							disabled={!!hasConversations}
						>
							<Button
								onClick={() => handleCreate(false)}
								loading={isPending}
								disabled={isPending || !hasConversations}
								color="primary"
								style={{ flex: 7 }}
								{...testId("report-create-button")}
							>
								<Trans>Generate now</Trans>
							</Button>
						</Tooltip>
						<Button
							variant="outline"
							onClick={() => setShowSchedule(true)}
							leftSection={<IconClock size={16} />}
							style={{ flex: 3 }}
						>
							<Trans>Schedule</Trans>
						</Button>
					</Group>

					{SHOW_STRUCTURE_CTA && (
						<>
							<Divider mt="md" />
							<Text size="xs" c="gray.6" mt="sm">
								<Trans>Report templates are on our roadmap.</Trans>{" "}
								<Anchor
									href={getProductFeedbackUrl(appLocale)}
									target="_blank"
									size="xs"
									td="underline"
								>
									<Trans>Share your ideas with our team</Trans>{" "}
									<IconExternalLink
										size={11}
										style={{ display: "inline", verticalAlign: "middle" }}
									/>
								</Anchor>
							</Text>
						</>
					)}
				</Stack>
			)}
		</Stack>
	);
};
