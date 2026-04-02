import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Anchor,
	Alert,
	Badge,
	Box,
	Button,
	Divider,
	Group,
	Modal,
	NativeSelect,
	Stack,
	Text,
} from "@mantine/core";
import { DateTimePicker } from "@mantine/dates";
import { IconArrowLeft, IconClock, IconExternalLink } from "@tabler/icons-react";
import { AxiosError } from "axios";
import { MessageCircleIcon } from "lucide-react";
import { useState } from "react";
import { useParams } from "react-router";
import { useProjectConversationCounts } from "@/components/report/hooks";
import { useLanguage } from "@/hooks/useLanguage";
import { getProductFeedbackUrl } from "@/config";
import { testId } from "@/lib/testUtils";
import focusOptionsData from "@/data/reportFocusOptions.json";
import { CloseableAlert } from "../common/ClosableAlert";
import { languageOptionsByIso639_1 } from "../language/LanguagePicker";
import { ConversationStatusTable } from "./ConversationStatusTable";
import { ReportFocusSelector } from "./ReportFocusSelector";
import { useCreateProjectReportMutation } from "./hooks";

function getLanguageLabel(iso: string): string {
	return languageOptionsByIso639_1.find((o) => o.value === iso)?.label ?? iso;
}

function getSelectedFocusLabels(instructions: string, language: string): string[] {
	return focusOptionsData.options
		.filter((opt) => instructions.includes(opt.instruction))
		.map((opt) => (opt.labels as Record<string, string>)[language] ?? opt.labels.en);
}

function getCustomFocusText(instructions: string): string {
	let remaining = instructions;
	for (const opt of focusOptionsData.options) {
		remaining = remaining.replace(opt.instruction, "");
	}
	return remaining.replace(/\n{2,}/g, "\n").trim();
}

function getMinScheduleDate(): Date {
	const d = new Date(Date.now() + 10 * 60_000);
	const mins = d.getMinutes();
	const remainder = mins % 5;
	if (remainder !== 0) d.setMinutes(mins + (5 - remainder), 0, 0);
	return d;
}

function getMaxScheduleDate(): Date {
	return new Date(Date.now() + 30 * 24 * 60 * 60_000);
}

// Feature flag: show "custom report structure" CTA until 2026-05-11
const SHOW_STRUCTURE_CTA = Date.now() < new Date("2026-05-11T00:00:00Z").getTime();

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

	const hasConversations = conversationCounts && conversationCounts.total > 0;
	const hasFinishedConversations =
		conversationCounts && conversationCounts.finished > 0;
	const conversationTotal = conversationCounts?.total ?? 0;

	const is409Error =
		error instanceof AxiosError && error.response?.status === 409;

	const handleCreate = (schedule?: boolean) => {
		mutate(
			{
				language,
				userInstructions: userInstructions || undefined,
				scheduledAt:
					schedule && scheduledDate
						? scheduledDate.toISOString()
						: undefined,
				projectId: projectId ?? "",
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

	if (!hasConversations) {
		return (
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
		);
	}

	return (
		<Stack maw="540px" className="pt-4">
			<CloseableAlert title={t`Generate a Report`} storageKey="create-report-info-dismissed">
				<Trans>
					It looks like you don't have a report for this project yet. Generate
					one to get an overview of your conversations.
				</Trans>
			</CloseableAlert>

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

			{!hasFinishedConversations ? (
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
						<Badge size="xs" variant="light" color="yellow">
							<Trans>Experimental</Trans>
						</Badge>
					</Group>

					{/* Summary of selected options */}
					<Stack gap={4}>
						<Text size="xs" c="dimmed">
							<Trans>Language</Trans>: {getLanguageLabel(language)}
							{getSelectedFocusLabels(userInstructions, language).length > 0 && (
								<>
									{" · "}
									<Trans>Focus</Trans>:{" "}
									{getSelectedFocusLabels(userInstructions, language).join(", ")}
								</>
							)}
							{getCustomFocusText(userInstructions) && (
								<>
									{" · "}
									<Text span fs="italic" size="xs" c="dimmed">
										"{getCustomFocusText(userInstructions).length > 60
											? `${getCustomFocusText(userInstructions).slice(0, 60)}…`
											: getCustomFocusText(userInstructions)}"
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

					<DateTimePicker
						label={t`When should the report be generated?`}
						placeholder={t`e.g. tomorrow at 9:00`}
						value={scheduledDate}
						onChange={setScheduledDate}
						minDate={getMinScheduleDate()}
						maxDate={getMaxScheduleDate()}
						clearable
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
							disabled={isPending || !scheduledDate}
							fullWidth
							color="teal"
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
						<Button
							onClick={() => handleCreate(false)}
							loading={isPending}
							disabled={isPending}
							color="teal"
							style={{ flex: 7 }}
							{...testId("report-create-button")}
						>
							<Trans>Generate now</Trans>
						</Button>
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
