import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Anchor,
	Badge,
	Button,
	Divider,
	Group,
	Indicator,
	Modal,
	NativeSelect,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	ArrowLeftIcon,
	ClockIcon,
	PencilSimpleIcon,
} from "@phosphor-icons/react";
import { AxiosError } from "axios";
import posthog from "posthog-js";
import { useState } from "react";
import { useParams } from "react-router";
import { FeedbackPortalModal } from "@/components/common/FeedbackPortalModal";
import {
	AiBudgetWall,
	useAiBudgetWall,
} from "@/components/workspace/AiBudgetWall";
import focusOptionsData from "@/data/reportFocusOptions.json";
import { useAllowanceApplies } from "@/hooks/useAllowanceApplies";
import { useFreeAllowance } from "@/hooks/useFreeAllowance";
import { useLanguage } from "@/hooks/useLanguage";
import { useWorkspace } from "@/hooks/useWorkspace";
import { aiBudgetDetails, isFreeTierLimitError } from "@/lib/freeTier";
import { testId } from "@/lib/testUtils";
import { languageOptionsByIso639_1 } from "../language/LanguagePicker";
import { useCreateProjectReportMutation, useProjectReport } from "./hooks";
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

// Feature flag: show "custom report structure" CTA until 2026-05-11 (8 weeks from 2026-03-16)
const SHOW_STRUCTURE_CTA =
	Date.now() < new Date("2026-05-11T00:00:00Z").getTime();

export const UpdateReportModalButton = ({
	reportId: currentReportId,
	needsUpdate = false,
}: {
	reportId: number;
	needsUpdate?: boolean;
}) => {
	const [opened, { open, close }] = useDisclosure(false);
	const aiWall = useAiBudgetWall();
	const { mutateAsync, isPending, error } = useCreateProjectReportMutation();
	const { projectId } = useParams();
	// Free tier: once this month's AI is used up, "Create report" opens the AI wall.
	const { workspace } = useWorkspace();
	const { applies: allowanceApplies } = useAllowanceApplies(projectId);
	const freeAllowance = useFreeAllowance(workspace?.id);
	const aiUsedUp =
		allowanceApplies && Boolean(freeAllowance.data?.ai?.exhausted);
	const { data: currentReport } = useProjectReport(
		projectId ?? "",
		currentReportId,
	);
	const { iso639_1, language: appLocale } = useLanguage();

	const [language, setLanguage] = useState(
		currentReport?.language ?? iso639_1 ?? "en",
	);
	const [userInstructions, setUserInstructions] = useState(
		currentReport?.user_instructions ?? "",
	);
	const [showSchedule, setShowSchedule] = useState(false);
	const [scheduledDate, setScheduledDate] = useState<Date | null>(null);
	const [feedbackOpen, setFeedbackOpen] = useState(false);

	if (!currentReport) {
		return null;
	}

	const is409Error =
		error instanceof AxiosError && error.response?.status === 409;
	// A sample project keeps one report of its own.
	const isSampleRefusal = isFreeTierLimitError(error) === "report";
	// The AI wall answered this one; the form shows no error for it.
	const shownError = aiBudgetDetails(error) ? null : error;

	const handleOpen = () => {
		// With this month's AI used up, route straight to the upgrade path.
		if (aiUsedUp) {
			aiWall.open(freeAllowance.data?.resets_at ?? null);
			return;
		}
		setLanguage(currentReport.language ?? iso639_1 ?? "en");
		setUserInstructions(currentReport.user_instructions ?? "");
		setShowSchedule(false);
		setScheduledDate(null);
		open();
	};

	const handleSubmit = async (schedule?: boolean) => {
		posthog.capture("report_updated");
		try {
			await mutateAsync(
				{
					language,
					otherPayload: {
						show_portal_link: currentReport.show_portal_link,
					},
					projectId: projectId ?? "",
					scheduledAt:
						schedule && scheduledDate ? scheduledDate.toISOString() : undefined,
					userInstructions: userInstructions || undefined,
				},
				{ onSuccess: () => close() },
			);
		} catch (err) {
			// The modal shows any other failure from the mutation's error.
			if (aiWall.openFor(err)) close();
		}
	};

	return (
		<>
			<Group gap="xs">
				<Tooltip
					label={
						needsUpdate
							? t`New conversations added since this report`
							: t`Generate a new report`
					}
				>
					<Indicator
						disabled={!needsUpdate}
						color="salmon"
						size={10}
						offset={4}
					>
						<Button
							variant="filled"
							color="primary"
							onClick={handleOpen}
							leftSection={<PencilSimpleIcon size={20} />}
							opacity={aiUsedUp ? 0.7 : 1}
							{...testId("report-update-button")}
						>
							<Trans>Create report</Trans>
						</Button>
					</Indicator>
				</Tooltip>
			</Group>

			<Modal
				opened={opened}
				onClose={close}
				title={
					<Group gap="xs" align="center">
						<Text size="lg">
							{showSchedule ? (
								<Trans>Schedule report</Trans>
							) : (
								<Trans>Create report</Trans>
							)}
						</Text>
						{showSchedule && (
							<Badge color="mauve" c="graphite" size="sm">
								<Trans>Beta</Trans>
							</Badge>
						)}
					</Group>
				}
			>
				{isSampleRefusal ? (
					<Alert
						title={t`Report limit reached`}
						color="primary"
						variant="light"
					>
						<Stack gap="sm" align="flex-start">
							<Text size="sm">
								<Trans>This sample project includes one report.</Trans>
							</Text>
							<Button
								size="xs"
								onClick={() => {
									close();
									aiWall.open(null, false);
								}}
							>
								{t`See upgrade options`}
							</Button>
						</Stack>
					</Alert>
				) : shownError ? (
					<Alert
						title={
							is409Error
								? t`Report already generating`
								: t`Error creating report`
						}
						color={is409Error ? "yellow" : "red"}
					>
						{is409Error ? (
							<Trans>
								A report is already being generated for this project. Please
								wait for it to complete.
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
						<Stack gap="xs">
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
								<Group gap="xs">
									<ArrowLeftIcon size={16} />
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
								onClick={() => handleSubmit(true)}
								loading={isPending}
								disabled={isPending || !isDateFarEnough(scheduledDate)}
								fullWidth
								variant="filled"
							>
								<Trans>Schedule report</Trans>
							</Button>
							<Button
								variant="subtle"
								color="gray"
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
						<Group gap="xs" mt="lg" wrap="wrap">
							<Button
								onClick={() => handleSubmit(false)}
								loading={isPending}
								disabled={isPending}
								variant="filled"
								style={{ flex: 7 }}
								{...testId("report-generate-button")}
							>
								<Trans>Generate now</Trans>
							</Button>
							<Button
								onClick={() => setShowSchedule(true)}
								leftSection={<ClockIcon size={20} />}
								style={{ flex: 3 }}
							>
								<Trans>Schedule</Trans>
							</Button>
						</Group>

						{/* Footer CTA — quiet, left-aligned, separated */}
						{SHOW_STRUCTURE_CTA && (
							<>
								<Divider mt="md" />
								<Text size="xs" c="dimmed" mt="sm">
									<Trans>Report templates are on our roadmap.</Trans>{" "}
									<Anchor
										component="button"
										type="button"
										onClick={() => setFeedbackOpen(true)}
										size="xs"
										td="underline"
									>
										<Trans>Share your ideas with our team</Trans>
									</Anchor>
								</Text>
							</>
						)}
					</Stack>
				)}
			</Modal>
			<FeedbackPortalModal
				opened={feedbackOpen}
				onClose={() => setFeedbackOpen(false)}
				locale={appLocale}
			/>
			<AiBudgetWall
				{...aiWall.props}
				action="report"
				workspaceId={workspace?.id ?? ""}
				projectId={projectId}
			/>
		</>
	);
};
