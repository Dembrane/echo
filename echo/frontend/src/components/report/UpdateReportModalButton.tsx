import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Anchor,
	Alert,
	Badge,
	Button,
	Divider,
	Group,
	Modal,
	NativeSelect,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import { DateTimePicker } from "@mantine/dates";
import { useDisclosure } from "@mantine/hooks";
import {
	IconArrowLeft,
	IconClock,
	IconExternalLink,
	IconPencil,
} from "@tabler/icons-react";
import { AxiosError } from "axios";
import { useState } from "react";
import { useParams } from "react-router";
import { useLanguage } from "@/hooks/useLanguage";
import { analytics } from "@/lib/analytics";
import { testId } from "@/lib/testUtils";
import { AnalyticsEvents as events } from "@/lib/analyticsEvents";
import { getProductFeedbackUrl } from "@/config";
import focusOptionsData from "@/data/reportFocusOptions.json";
import { languageOptionsByIso639_1 } from "../language/LanguagePicker";
import { ReportFocusSelector } from "./ReportFocusSelector";
import {
	useCreateProjectReportMutation,
	useDoesProjectReportNeedUpdate,
	useProjectReport,
} from "./hooks";

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

/** Returns a Date 10 minutes from now (rounded up to next 5-min mark). */
function getMinScheduleDate(): Date {
	const d = new Date(Date.now() + 10 * 60_000);
	const mins = d.getMinutes();
	const remainder = mins % 5;
	if (remainder !== 0) d.setMinutes(mins + (5 - remainder), 0, 0);
	return d;
}

/** 30 days from now. */
function getMaxScheduleDate(): Date {
	return new Date(Date.now() + 30 * 24 * 60 * 60_000);
}

// Feature flag: show "custom report structure" CTA until 2026-05-11 (8 weeks from 2026-03-16)
const SHOW_STRUCTURE_CTA = Date.now() < new Date("2026-05-11T00:00:00Z").getTime();

export const UpdateReportModalButton = ({
	reportId: currentReportId,
}: {
	reportId: number;
}) => {
	const [opened, { open, close }] = useDisclosure(false);
	const { mutateAsync, isPending, error } = useCreateProjectReportMutation();
	const { projectId } = useParams();
	const { data: currentReport } = useProjectReport(projectId ?? "", currentReportId);
	const { data: doesReportNeedUpdate } =
		useDoesProjectReportNeedUpdate(projectId ?? "", currentReportId);
	const { iso639_1, language: appLocale } = useLanguage();

	const [language, setLanguage] = useState(
		currentReport?.language ?? iso639_1 ?? "en",
	);
	const [userInstructions, setUserInstructions] = useState(
		currentReport?.user_instructions ?? "",
	);
	const [showSchedule, setShowSchedule] = useState(false);
	const [scheduledDate, setScheduledDate] = useState<Date | null>(null);

	if (!currentReport) {
		return null;
	}

	const is409Error =
		error instanceof AxiosError && error.response?.status === 409;

	const handleOpen = () => {
		setLanguage(currentReport.language ?? iso639_1 ?? "en");
		setUserInstructions(currentReport.user_instructions ?? "");
		setShowSchedule(false);
		setScheduledDate(null);
		open();
	};

	const handleSubmit = async (schedule?: boolean) => {
		try {
			analytics.trackEvent(events.UPDATE_REPORT);
		} catch (error) {
			console.warn("Analytics tracking failed:", error);
		}
		await mutateAsync(
			{
				language,
				userInstructions: userInstructions || undefined,
				otherPayload: {
					show_portal_link: currentReport.show_portal_link,
				},
				scheduledAt:
					schedule && scheduledDate
						? scheduledDate.toISOString()
						: undefined,
				projectId: projectId ?? "",
			},
			{
				onSuccess: () => close(),
			},
		);
	};

	return (
		<>
			<Tooltip
				label={
					doesReportNeedUpdate
						? t`New conversations available — update your report`
						: t`Generate a new report`
				}
			>
				<Button
					variant="filled"
					color="blue"
					onClick={handleOpen}
					leftSection={<IconPencil size={16} />}
					rightSection={
						doesReportNeedUpdate ? (
							<span
								style={{
									display: "inline-block",
									width: 8,
									height: 8,
									borderRadius: "50%",
									backgroundColor: "var(--mantine-color-red-filled)",
								}}
							/>
						) : undefined
					}
					{...testId("report-update-button")}
				>
					{doesReportNeedUpdate ? (
						<Trans>Update Report</Trans>
					) : (
						<Trans>New Report</Trans>
					)}
				</Button>
			</Tooltip>

			<Modal
				opened={opened}
				onClose={close}
				title={
					<Group gap="xs" align="center">
						<Text fw={500} size="lg">
							{showSchedule ? (
								<Trans>Schedule Report</Trans>
							) : doesReportNeedUpdate ? (
								<Trans>Update Report</Trans>
							) : (
								<Trans>New Report</Trans>
							)}
						</Text>
						{showSchedule && (
							<Badge size="xs" variant="light" color="yellow">
								<Trans>Experimental</Trans>
							</Badge>
						)}
					</Group>
				}
			>
				{error ? (
					<Alert
						title={
							is409Error ? t`Report already generating` : t`Error creating report`
						}
						color={is409Error ? "yellow" : "red"}
					>
						{is409Error ? (
							<Trans>
								A report is already being generated for this project. Please wait
								for it to complete.
							</Trans>
						) : (
							<Trans>
								There was an error creating your report. Please try again or
								contact support.
							</Trans>
						)}
					</Alert>
				) : showSchedule ? (
					<Stack>
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
								onClick={() => handleSubmit(true)}
								loading={isPending}
								disabled={isPending || !scheduledDate}
								fullWidth
								color="blue"
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
						{/* Group 1: Inputs — language + focus are one conceptual unit */}
						<Stack gap="md">
							<NativeSelect
								value={language}
								label={t`Language`}
								onChange={(e) => setLanguage(e.target.value)}
								data={languageOptionsByIso639_1}
							/>

							<ReportFocusSelector
								value={userInstructions}
								onChange={setUserInstructions}
								language={language}
							/>
						</Stack>

						{/* Larger gap separates inputs from commitment */}
						<Group gap="xs" mt={24} wrap="wrap">
							<Button
								onClick={() => handleSubmit(false)}
								loading={isPending}
								disabled={isPending}
								color="blue"
								style={{ flex: 7 }}
								{...testId("report-generate-button")}
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

						{/* Footer CTA — quiet, left-aligned, separated */}
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
			</Modal>
		</>
	);
};
