import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Alert,
	Anchor,
	Badge,
	Box,
	Button,
	Divider,
	Group,
	Menu,
	Paper,
	Skeleton,
	Stack,
	Switch,
	Text,
	Title,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { useDisclosure, useFullscreen } from "@mantine/hooks";
import {
	CheckIcon,
	CopyIcon,
	CornersInIcon,
	CornersOutIcon,
	DotsThreeVerticalIcon,
	GearSixIcon,
	PlayIcon,
	PrinterIcon,
	TrashIcon,
} from "@phosphor-icons/react";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import posthog from "posthog-js";
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { Breadcrumbs } from "@/components/common/Breadcrumbs";
import { CloseableAlert } from "@/components/common/ClosableAlert";
import { ConfirmModal } from "@/components/common/ConfirmModal";
import { ExponentialProgress } from "@/components/common/ExponentialProgress";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import { CreateReportForm } from "@/components/report/CreateReportForm";
import {
	useAllProjectReports,
	useCancelScheduledReportMutation,
	useCreateProjectReportMutation,
	useDeleteProjectReportMutation,
	useDoesProjectReportNeedUpdate,
	useGetProjectParticipants,
	useLatestProjectReport,
	useProjectReport,
	useProjectReportViews,
	useReportProgress,
	useUpdateProjectReportMutation,
} from "@/components/report/hooks";
import { ReportRenderer } from "@/components/report/ReportRenderer";
import { ReportTimeline } from "@/components/report/ReportTimeline";
import {
	isDateFarEnough,
	ScheduleDateTimePicker,
} from "@/components/report/ScheduleDateTimePicker";
import { UpdateReportModalButton } from "@/components/report/UpdateReportModalButton";
import { QRMenu, ShareButton, ShareControls } from "@/components/sharing/Share";
import { reportStatusLabel, StatusLine } from "@/components/sharing/StatusLine";
import { PARTICIPANT_BASE_URL } from "@/config";
import focusOptionsData from "@/data/reportFocusOptions.json";
import useCopyToRichText from "@/hooks/useCopyToRichText";
import { useLanguage } from "@/hooks/useLanguage";
import { testId } from "@/lib/testUtils";

dayjs.extend(relativeTime);

/** Parse user_instructions into readable labels for the tooltip. */
function formatGuidedTooltip(instructions: string, language: string): string {
	const presetLabels = focusOptionsData.options
		.filter((opt) => instructions.includes(opt.instruction))
		.map(
			(opt) =>
				(opt.labels as Record<string, string>)[language] ?? opt.labels.en,
		);

	let custom = instructions;
	for (const opt of focusOptionsData.options) {
		custom = custom.replace(opt.instruction, "");
	}
	custom = custom.replace(/\n{2,}/g, "\n").trim();

	const parts: string[] = [];
	if (presetLabels.length > 0) {
		parts.push(presetLabels.map((l) => `• ${l}`).join("\n"));
	}
	if (custom) {
		parts.push(`• "${custom}"`);
	}
	return parts.join("\n");
}

/** Type for report list items returned by the backend. */
type ReportListItem = Pick<
	ProjectReport,
	| "id"
	| "status"
	| "date_created"
	| "language"
	| "user_instructions"
	| "scheduled_at"
> & {
	title?: string | null;
};

// ── Language tag helper ──

const LANG_LABELS: Record<string, string> = {
	de: "DE",
	en: "EN",
	es: "ES",
	fr: "FR",
	it: "IT",
	nl: "NL",
};

// ── Status ──

/** Status as a Badge: green published, yellow scheduled, primary while it is
 * generating (in progress), gray otherwise. */
function getStatusMeta(status: string): { color: string; label: string } {
	switch (status) {
		case "published":
			return { color: "green", label: reportStatusLabel(status) };
		case "scheduled":
			return { color: "yellow", label: reportStatusLabel(status) };
		case "draft":
			return { color: "primary", label: reportStatusLabel(status) };
		default:
			return { color: "gray", label: reportStatusLabel(status) };
	}
}

// ── Layouts ──

export const ReportLayout = ({
	children,
	rightSection,
	status,
}: {
	children: React.ReactNode;
	rightSection?: React.ReactNode;
	/** The status line, under the title. */
	status?: React.ReactNode;
}) => {
	return (
		<Stack
			gap="1.5rem"
			px={{ base: "1rem", md: "2rem" }}
			py={{ base: "2rem", md: "3rem" }}
		>
			<Group justify="space-between" wrap="wrap" align="flex-start">
				<Stack gap="xs">
					<Breadcrumbs
						items={[
							{
								label: (
									<Title order={2}>
										<Trans>Report</Trans>
									</Title>
								),
							},
						]}
					/>
					{status}
				</Stack>
				{rightSection}
			</Group>
			{children}
		</Stack>
	);
};

// ── Analytics ──

const ProjectReportAnalytics = ({
	projectId,
	reportId,
}: {
	projectId: string;
	reportId: number;
}) => {
	const { data: views } = useProjectReportViews(projectId, reportId);
	const [opened, { toggle }] = useDisclosure();

	return (
		<Stack gap="1.5rem" id="report-analytics">
			<Group>
				<Title order={4}>
					<Trans>Analytics</Trans>
				</Title>
				<ActionIcon onClick={toggle}>
					<GearSixIcon size={20} />
				</ActionIcon>
			</Group>
			<Stack gap="1rem">
				<Text>
					<Trans>This report was opened by {views?.total ?? 0} people</Trans>
				</Text>
				<ReportTimeline reportId={String(reportId)} showBrush={opened} />
			</Stack>
		</Stack>
	);
};

// ── Progress view ──

const ReportProgressView = ({
	projectId,
	reportId,
	dateCreated,
}: {
	projectId: string;
	reportId: number;
	dateCreated?: string | null;
}) => {
	const { progress } = useReportProgress(projectId, reportId);
	const { mutate: updateReport, isPending: isCancelling } =
		useUpdateProjectReportMutation();

	const progressMessage =
		progress?.message ?? t`Report generation in progress...`;

	const expectedDuration = 250;
	const startFrom = (() => {
		if (!dateCreated) return 0;
		const elapsedSeconds =
			(Date.now() - new Date(dateCreated).getTime()) / 1000;
		if (elapsedSeconds <= 0) return 0;
		const scaleFactor = 0.1 * (5 / expectedDuration);
		return Math.min(100 - 100 * Math.exp(-scaleFactor * elapsedSeconds), 95);
	})();

	const handleCancel = () => {
		updateReport({
			payload: { status: "cancelled" },
			projectId,
			reportId,
		});
	};

	return (
		<Stack>
			<Alert title={t`Generating your report...`} mt="sm">
				<Text size="sm">{progressMessage}</Text>
				<Text size="xs" c="dimmed" mt="xs">
					<Trans>
						You can navigate away and come back later. Your report will continue
						generating in the background.
					</Trans>
				</Text>
			</Alert>
			<ExponentialProgress
				expectedDuration={250}
				isLoading={true}
				startFrom={startFrom}
			/>
			<Group justify="flex-start" mt="md">
				<Button
					variant="subtle"
					color="gray"
					onClick={handleCancel}
					loading={isCancelling}
					{...testId("report-cancel-button")}
				>
					<Trans>Cancel</Trans>
				</Button>
			</Group>
		</Stack>
	);
};

// ── Version list item ──

function VersionItem({
	report,
	isActive,
	isLatest,
	onClick,
}: {
	report: ReportListItem;
	isActive: boolean;
	isLatest?: boolean;
	onClick: () => void;
}) {
	const sc = getStatusMeta(report.status);
	const isScheduled = report.status === "scheduled";
	const isGenerating = report.status === "draft";

	const title = isGenerating
		? t`Generating report...`
		: report.title || t`Untitled report`;

	const langTag = report.language
		? (LANG_LABELS[report.language] ?? report.language.toUpperCase())
		: null;

	// Relative time for a compact display
	const timeAgo =
		isScheduled && report.scheduled_at
			? dayjs(report.scheduled_at).fromNow()
			: report.date_created
				? dayjs(report.date_created).fromNow()
				: "";

	// Status badge logic — published/scheduled/generating always show their status.
	// "custom" only shows for archived reports with instructions. Hide badge for plain older archived.
	const tagLabel =
		report.status === "published" ||
		report.status === "scheduled" ||
		report.status === "draft"
			? sc.label
			: report.status === "archived" && isLatest
				? t`Latest`
				: report.user_instructions
					? t`Guided`
					: sc.label;
	const hideBadge =
		report.status === "archived" && !isLatest && !report.user_instructions;

	const metaParts = [
		...(!isGenerating && timeAgo ? [{ key: "time", text: timeAgo }] : []),
		...(langTag ? [{ key: "lang", text: langTag }] : []),
	];

	return (
		<UnstyledButton
			className="app-do"
			data-selected={isActive || undefined}
			onClick={onClick}
			px="sm"
			py="xs"
			w="100%"
		>
			<Stack gap="xs" style={{ minWidth: 0 }}>
				{/* Title row */}
				<Text size="xs" lineClamp={1} fs={isGenerating ? "italic" : undefined}>
					{title}
				</Text>

				{/* Meta row: status, time, language */}
				<Group gap="xs" wrap="nowrap">
					{!hideBadge && (
						<Badge size="sm" color={sc.color} style={{ flexShrink: 0 }}>
							{tagLabel}
						</Badge>
					)}
					{metaParts.map((part, i) => (
						<Text
							key={part.key}
							size="xs"
							c="dimmed"
							truncate={part.key === "time"}
							style={{ flexShrink: part.key === "time" ? 1 : 0 }}
						>
							{i > 0 || !hideBadge ? `· ${part.text}` : part.text}
						</Text>
					))}
				</Group>
			</Stack>
		</UnstyledButton>
	);
}

// ── Scrollable sidebar container ──

function ScrollableSidebar({ children }: { children: React.ReactNode }) {
	return <Box style={{ maxHeight: 360, overflowY: "auto" }}>{children}</Box>;
}

// ── Scheduled report state view ──

function ScheduledReportView({
	report,
	projectId,
	onReset,
}: {
	report: ReportListItem;
	projectId: string;
	onReset: () => void;
}) {
	const { mutate: cancelSchedule, isPending: isCancelling } =
		useCancelScheduledReportMutation();
	const { mutate: createReport, isPending: isCreating } =
		useCreateProjectReportMutation();
	const {
		mutate: updateReport,
		isPending: isRescheduling,
		error: rescheduleError,
	} = useUpdateProjectReportMutation();
	const [showReschedule, setShowReschedule] = useState(false);
	const [newDate, setNewDate] = useState<Date | null>(
		report.scheduled_at ? new Date(report.scheduled_at) : null,
	);

	const handleGenerateNow = () => {
		cancelSchedule(
			{ projectId, reportId: report.id },
			{
				onSuccess: () => {
					createReport(
						{
							language: report.language ?? "en",
							projectId,
							userInstructions: report.user_instructions ?? undefined,
						},
						{
							onSuccess: () => onReset(),
						},
					);
				},
			},
		);
	};

	const handleCancelSchedule = () => {
		cancelSchedule(
			{ projectId, reportId: report.id },
			{ onSuccess: () => onReset() },
		);
	};

	const handleReschedule = () => {
		if (!newDate) return;
		updateReport(
			{
				payload: { scheduled_at: newDate.toISOString() },
				projectId,
				reportId: report.id,
			},
			{
				onSuccess: () => setShowReschedule(false),
			},
		);
	};

	const scheduledTime = report.scheduled_at
		? dayjs(report.scheduled_at).format("ddd, MMM D [at] h:mm A")
		: "";

	// Disable reschedule if less than 10 minutes until scheduled time
	const canReschedule = report.scheduled_at
		? dayjs(report.scheduled_at).diff(dayjs(), "minute") >= 10
		: true;

	return (
		<Stack align="flex-start" py="xl" gap="md">
			<Title order={4}>
				<Trans>Report scheduled</Trans>
			</Title>
			<Text size="sm" c="dimmed" maw={360}>
				<Trans>
					A new report will be automatically generated and published at the
					scheduled time.
				</Trans>
			</Text>
			{scheduledTime && <Badge color="yellow">{scheduledTime}</Badge>}

			{showReschedule ? (
				<Stack gap="xs" w={280}>
					<ScheduleDateTimePicker
						label={t`Reschedule to`}
						value={newDate}
						onChange={setNewDate}
					/>
					<ErrorNotice
						error={rescheduleError}
						title={t`Failed to reschedule. Please choose a time further in the future and try again.`}
					/>
					<Button
						variant="filled"
						onClick={handleReschedule}
						loading={isRescheduling}
						disabled={!newDate || !isDateFarEnough(newDate) || isRescheduling}
						fullWidth
					>
						<Trans>Confirm reschedule</Trans>
					</Button>
					<Button
						variant="subtle"
						color="gray"
						fullWidth
						onClick={() => setShowReschedule(false)}
					>
						<Trans>Back</Trans>
					</Button>
				</Stack>
			) : (
				<>
					<Button
						leftSection={<PlayIcon size={20} />}
						onClick={handleGenerateNow}
						loading={isCancelling || isCreating}
					>
						<Trans>Generate now</Trans>
					</Button>
					<Group gap="xs" justify="flex-start">
						<Tooltip
							label={t`Cannot reschedule within 10 minutes of the scheduled time`}
							disabled={canReschedule}
						>
							<Box>
								<Button
									variant="subtle"
									color="gray"
									size="xs"
									disabled={!canReschedule}
									onClick={() => setShowReschedule(true)}
								>
									<Trans>Reschedule</Trans>
								</Button>
							</Box>
						</Tooltip>
						<Button
							variant="subtle"
							color="gray"
							size="xs"
							onClick={handleCancelSchedule}
						>
							<Trans>Cancel schedule</Trans>
						</Button>
					</Group>
				</>
			)}
		</Stack>
	);
}

// ── Main component ──

export const ProjectReportRoute = () => {
	const { projectId } = useParams();
	const { language } = useLanguage();
	const { data: latestReport, isLoading } = useLatestProjectReport(
		projectId ?? "",
	);
	const { data: allReports } = useAllProjectReports(projectId ?? "");
	const [selectedReportId, setSelectedReportId] = useState<number | null>(null);
	const {
		ref: fullscreenRef,
		toggle: toggleFullscreen,
		fullscreen,
	} = useFullscreen();
	const [isEditing, setIsEditing] = useState(false);

	// Reports with content (completed)
	const completedReports =
		allReports?.filter(
			(r) => r.status === "archived" || r.status === "published",
		) ?? [];

	// Scheduled reports
	const scheduledReports =
		allReports?.filter((r) => r.status === "scheduled") ?? [];

	// Currently generating reports
	const generatingReports =
		allReports?.filter((r) => r.status === "draft") ?? [];

	// All displayable reports for the sidebar, sorted by date (latest first)
	const sidebarReports = [
		...generatingReports,
		...completedReports,
		...scheduledReports,
	].sort((a, b) => {
		const dateA = a.date_created ? new Date(a.date_created).getTime() : 0;
		const dateB = b.date_created ? new Date(b.date_created).getTime() : 0;
		return dateB - dateA;
	});

	const latestCompletedId = completedReports[0]?.id ?? -1;

	const isFallbackFromFailure =
		latestReport?.status === "cancelled" || latestReport?.status === "error";

	// Is the user viewing a generating report?
	const isViewingGenerating = sidebarReports.find(
		(r) => r.id === selectedReportId && r.status === "draft",
	);

	// Detect if viewing a scheduled report
	const selectedScheduledReport = sidebarReports.find(
		(r) => r.id === selectedReportId && r.status === "scheduled",
	);
	const isViewingScheduled = !!selectedScheduledReport;

	// If the selected report was cancelled/errored (or no longer in the list),
	// fall through to the latest completed report instead of showing an empty page.
	const isSelectedStale =
		selectedReportId !== null &&
		allReports !== undefined &&
		!allReports.some((r) => r.id === selectedReportId);

	// Determine which report to display (never load content for a scheduled or draft report)
	const activeReportId = (() => {
		if (
			selectedReportId &&
			!isViewingScheduled &&
			!isViewingGenerating &&
			!isSelectedStale
		)
			return selectedReportId;
		if (
			latestReport &&
			(latestReport.status === "cancelled" ||
				latestReport.status === "error" ||
				latestReport.status === "scheduled" ||
				latestReport.status === "draft") &&
			completedReports.length > 0
		) {
			return latestCompletedId;
		}
		if (latestReport?.status === "draft" && completedReports.length > 0) {
			return latestCompletedId;
		}
		return latestReport?.id ?? -1;
	})();

	const { data: activeReport } = useProjectReport(
		projectId ?? "",
		activeReportId,
	);

	const data =
		activeReport ??
		(latestReport?.status !== "scheduled" && latestReport?.status !== "draft"
			? latestReport
			: undefined);

	const { data: views } = useProjectReportViews(
		projectId ?? "",
		data?.id ?? -1,
	);
	const { data: doesReportNeedUpdate } = useDoesProjectReportNeedUpdate(
		projectId ?? "",
		data?.id ?? -1,
	);
	const { mutate: updateReport, isPending: isUpdatingReport } =
		useUpdateProjectReportMutation();
	const { mutate: deleteReport, isPending: isDeletingReport } =
		useDeleteProjectReportMutation();
	const [modalOpened, { open, close }] = useDisclosure(false);
	const [
		deleteModalOpened,
		{ open: openDeleteModal, close: closeDeleteModal },
	] = useDisclosure(false);
	const [publishStatus, setPublishStatus] = useState(false);
	const { data: participantCount } = useGetProjectParticipants(projectId ?? "");

	const handleConfirmPublish = () => {
		if (!data?.id || !projectId) return;
		updateReport({
			payload: { status: publishStatus ? "published" : "archived" },
			projectId,
			reportId: data.id,
		});
		close();
	};

	const handleConfirmDelete = () => {
		if (!data?.id || !projectId) return;
		deleteReport(
			{ projectId, reportId: data.id },
			{
				onSuccess: () => {
					setSelectedReportId(null);
				},
			},
		);
		closeDeleteModal();
	};

	const contributionLink = `${PARTICIPANT_BASE_URL}/${language}/${projectId}/start?utm_source=report`;

	const sharingLink = `${PARTICIPANT_BASE_URL}/${language}/${projectId}/report`;
	const includePortalLink = data?.show_portal_link ?? true;

	// The Public page switch is publishing. Participants who asked to hear about
	// the report are emailed when it is published, so that is confirmed first.
	const setPublic = (value: boolean) => {
		if (!data?.id || !projectId) return;
		if (value && (participantCount ?? 0) > 0) {
			setPublishStatus(true);
			open();
			return;
		}
		updateReport({
			payload: { status: value ? "published" : "archived" },
			projectId,
			reportId: data.id,
		});
	};

	const { copy: copyContent, copied: copiedContent } = useCopyToRichText();

	const handleSelectReport = (id: number) => {
		setSelectedReportId(id === latestCompletedId ? null : id);
	};

	// Clear stale selection (e.g. report was cancelled/errored and dropped from the list)
	useEffect(() => {
		if (isSelectedStale) {
			setSelectedReportId(null);
		}
	}, [isSelectedStale]);

	// Auto-select the first actionable sidebar report (scheduled/generating) when
	// there are no completed reports and nothing is selected yet.
	// Errored/cancelled reports are excluded — they're handled by the fallback UI.
	// biome-ignore lint/correctness/useExhaustiveDependencies: only re-run when sidebar/completed/selection changes
	useEffect(() => {
		if (completedReports.length === 0 && selectedReportId === null) {
			const firstActionable = sidebarReports[0];
			if (firstActionable) {
				setSelectedReportId(firstActionable.id);
			}
		}
	}, [sidebarReports.length, completedReports.length, selectedReportId]);

	// ── Loading ──
	if (isLoading) {
		return (
			<ReportLayout>
				<Divider />
				<Skeleton height="100px" />
				<Skeleton height="200px" />
			</ReportLayout>
		);
	}

	// ── No reports at all — first-time experience ──
	// Also shown when the only report errored/cancelled and there's nothing else to display
	if (!latestReport || (isFallbackFromFailure && sidebarReports.length === 0)) {
		return (
			<ReportLayout>
				<Divider />
				{latestReport && isFallbackFromFailure && (
					<CloseableAlert
						color={latestReport.status === "cancelled" ? "yellow" : "red"}
						title={
							latestReport.status === "cancelled"
								? t`Report generation cancelled`
								: t`Something went wrong`
						}
					>
						{latestReport.status === "cancelled" ? (
							<Trans>
								Report generation was cancelled. You can start a new report
								below.
							</Trans>
						) : latestReport.error_message ? (
							<Text size="sm">{latestReport.error_message}</Text>
						) : (
							<Trans>Something went wrong generating your report.</Trans>
						)}
					</CloseableAlert>
				)}
				<CreateReportForm onSuccess={() => {}} />
			</ReportLayout>
		);
	}

	// All non-null latestReport cases fall through to the two-column layout below.
	// The right pane handles: generating (ReportProgressView), scheduled (ScheduledReportView),
	// completed report (report content), or fallback (error/cancelled/empty → CreateReportForm).

	// ── Waiting for active report to load ──
	if (
		!data &&
		!isViewingGenerating &&
		!isViewingScheduled &&
		!isFallbackFromFailure
	) {
		return (
			<ReportLayout>
				<Divider />
				<Skeleton height="100px" />
				<Skeleton height="200px" />
			</ReportLayout>
		);
	}

	const activeReportMeta = completedReports.find(
		(r) => r.id === activeReportId,
	);

	const createdDate = data?.date_created
		? new Date(data.date_created).toLocaleString(undefined, {
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
				month: "short",
				year: "numeric",
			})
		: null;

	// Should we show the progress view in the right pane?
	const showProgressInContent = !!isViewingGenerating;

	// ── Two-column layout ──
	return (
		<>
			<ReportLayout
				status={
					data && (
						<StatusLine
							isPublic={data.status === "published"}
							onceAt={
								scheduledReports
									.map((r) => r.scheduled_at)
									.filter(Boolean)
									.sort()[0]
							}
						/>
					)
				}
				rightSection={
					<Group gap="xs">
						{/* Update/New report */}
						{data && (
							<UpdateReportModalButton
								reportId={data.id}
								needsUpdate={!!doesReportNeedUpdate}
							/>
						)}
					</Group>
				}
			>
				<Divider />

				{isFallbackFromFailure && (
					<CloseableAlert
						color={latestReport.status === "cancelled" ? "yellow" : "red"}
						title={
							latestReport.status === "cancelled"
								? t`Report generation cancelled`
								: t`Something went wrong`
						}
					>
						{latestReport.status === "cancelled" ? (
							<Trans>
								Your latest report generation was cancelled. Showing your most
								recent completed report.
							</Trans>
						) : (
							<>
								{latestReport.error_message ? (
									<Text size="sm">{latestReport.error_message}</Text>
								) : (
									<Trans>
										Something went wrong generating your latest report.
									</Trans>
								)}
								<Text size="sm" c="dimmed" mt="xs">
									<Trans>Showing your most recent completed report.</Trans>
								</Text>
							</>
						)}
					</CloseableAlert>
				)}

				{/* Two-column grid */}
				<div
					style={{
						alignItems: "start",
						display: "grid",
						gap: "1.5rem",
						gridTemplateColumns: "240px 1fr",
					}}
					className="report-grid"
				>
					{/* ── Left sidebar ── */}
					<Stack gap="md" style={{ position: "sticky", top: "1rem" }}>
						{/* Reports panel */}
						<Paper withBorder p="sm">
							<Stack gap="xs">
								<Group justify="space-between" px="xs">
									<Title order={5}>
										<Trans>Reports</Trans>
									</Title>
									{sidebarReports.length > 0 && (
										<Badge size="sm" color="gray">
											{sidebarReports.length}
										</Badge>
									)}
								</Group>
								<ScrollableSidebar>
									<Stack gap="xs">
										{sidebarReports.map((r) => (
											<VersionItem
												key={r.id}
												report={r}
												isActive={
													isViewingGenerating
														? r.id === selectedReportId
														: isViewingScheduled
															? r.id === selectedReportId
															: r.id === activeReportId
												}
												isLatest={
													r.status === "archived" && r.id === latestCompletedId
												}
												onClick={() => {
													setIsEditing(false);
													if (r.status === "scheduled") {
														setSelectedReportId(r.id);
													} else if (r.status === "draft") {
														setSelectedReportId(r.id);
													} else {
														handleSelectReport(r.id);
													}
												}}
											/>
										))}
									</Stack>
								</ScrollableSidebar>
								{sidebarReports.length === 0 && (
									<Text size="sm" c="dimmed" py="xs">
										<Trans>No reports yet</Trans>
									</Text>
								)}
							</Stack>
						</Paper>
					</Stack>

					{/* ── Right content area ── */}
					{showProgressInContent && isViewingGenerating ? (
						<ReportProgressView
							projectId={projectId ?? ""}
							reportId={isViewingGenerating.id}
							dateCreated={isViewingGenerating.date_created}
						/>
					) : isViewingScheduled && selectedScheduledReport ? (
						<ScheduledReportView
							report={selectedScheduledReport}
							projectId={projectId ?? ""}
							onReset={() => setSelectedReportId(null)}
						/>
					) : data ? (
						<Stack gap={0}>
							{/* ── Sticky toolbar ── */}
							<Paper
								withBorder
								p="sm"
								style={{
									backgroundColor: "var(--mantine-color-body)",
									position: "sticky",
									top: "1rem",
									zIndex: 5,
								}}
							>
								<Stack gap={0}>
									{/* Row 1: Share, and what else a host does with the report */}
									<Group justify="flex-start" wrap="wrap" gap="xs" py="xs">
										<ShareButton>
											<ShareControls
												isPublic={data.status === "published"}
												pending={isUpdatingReport}
												onPublicChange={setPublic}
												description={t`Anyone with the link can read it. No login, and no transcripts.`}
												qr={
													<QRMenu
														links={{ url: sharingLink }}
														fileName="report"
														onAction={(action) => {
															if (action === "copy")
																posthog.capture("report_link_copied", {
																	report_id: data.id,
																});
														}}
														extras={
															<>
																<Menu.Item
																	component="a"
																	href={`${sharingLink}?print=true`}
																	target="_blank"
																	rel="noopener noreferrer"
																	leftSection={<PrinterIcon size={16} />}
																	onClick={() =>
																		posthog.capture("report_exported", {
																			method: "print",
																			report_id: data.id,
																		})
																	}
																	{...testId("report-print-button")}
																>
																	<Trans>Download as PDF</Trans>
																</Menu.Item>
																<Menu.Item
																	closeMenuOnClick={false}
																	role="menuitemcheckbox"
																	aria-checked={includePortalLink}
																	leftSection={
																		includePortalLink ? (
																			<CheckIcon size={16} />
																		) : (
																			<Box w={16} />
																		)
																	}
																	onClick={() => {
																		posthog.capture("report_made_public", {
																			enabled: !includePortalLink,
																			report_id: data.id,
																		});
																		updateReport({
																			payload: {
																				show_portal_link: !includePortalLink,
																			},
																			projectId: projectId ?? "",
																			reportId: data.id,
																		});
																	}}
																	{...testId(
																		"report-include-portal-link-checkbox",
																	)}
																>
																	<Trans>Include portal link</Trans>
																</Menu.Item>
															</>
														}
													/>
												}
											/>
										</ShareButton>
										<Menu shadow="md" position="bottom-start">
											<Menu.Target>
												<Tooltip label={t`More actions`}>
													<ActionIcon {...testId("report-actions-menu")}>
														<DotsThreeVerticalIcon size={20} />
													</ActionIcon>
												</Tooltip>
											</Menu.Target>
											<Menu.Dropdown>
												<Menu.Item
													leftSection={<CopyIcon size={16} />}
													onClick={() => {
														if (activeReport?.content) {
															copyContent(activeReport.content);
														}
													}}
													{...testId("report-copy-content-button")}
												>
													{copiedContent ? (
														<Trans>Copied</Trans>
													) : (
														<Trans>Copy report content</Trans>
													)}
												</Menu.Item>
												<Menu.Divider />
												<Menu.Item
													leftSection={<TrashIcon size={16} />}
													color="red"
													onClick={openDeleteModal}
													{...testId("report-delete-button")}
												>
													<Trans>Delete report</Trans>
												</Menu.Item>
											</Menu.Dropdown>
										</Menu>
									</Group>

									{/* Separator between distribution and view controls */}
									<Divider my="xs" />

									{/* Row 2: View controls + metadata */}
									<Group justify="space-between" wrap="wrap" gap="sm" py="xs">
										<Group gap="sm" wrap="wrap">
											{createdDate && (
												<Text size="xs" c="dimmed">
													{createdDate}
												</Text>
											)}
											<Text size="xs" c="dimmed">
												·
											</Text>
											<Text size="xs" c="dimmed">
												<Plural
													value={views?.total ?? 0}
													one="# view"
													other="# views"
												/>
											</Text>
											<Text size="xs" c="dimmed">
												·
											</Text>
											<Anchor
												size="xs"
												c="dimmed"
												td="underline"
												href="#report-analytics"
											>
												<Trans>Analytics</Trans>
											</Anchor>
											{activeReportMeta?.user_instructions && (
												<>
													<Text size="xs" c="dimmed">
														·
													</Text>
													<Tooltip
														label={formatGuidedTooltip(
															activeReportMeta.user_instructions,
															language,
														)}
														multiline
														maw={300}
														position="bottom"
														styles={{ tooltip: { whiteSpace: "pre-line" } }}
													>
														<Text
															size="xs"
															c="dimmed"
															td="underline"
															style={{
																cursor: "pointer",
																textDecorationStyle: "dotted",
															}}
															{...testId("report-instructions-display")}
														>
															<Trans>Guided</Trans>
														</Text>
													</Tooltip>
												</>
											)}
										</Group>

										{/* View state controls — closest to preview */}
										<Group gap="sm" wrap="nowrap">
											<Switch
												label={t`Edit mode`}
												checked={isEditing}
												onChange={() => setIsEditing(!isEditing)}
												size="sm"
												{...testId("report-editing-mode-toggle")}
											/>
											<Tooltip
												label={fullscreen ? t`Exit fullscreen` : t`Fullscreen`}
											>
												<ActionIcon
													onClick={toggleFullscreen}
													{...testId("report-fullscreen-button")}
												>
													{fullscreen ? (
														<CornersInIcon size={20} />
													) : (
														<CornersOutIcon size={20} />
													)}
												</ActionIcon>
											</Tooltip>
										</Group>
									</Group>
								</Stack>
							</Paper>

							{/* ── Largest gap: separates toolbar from preview ── */}
							<Box mt="lg">
								<div
									ref={fullscreenRef}
									style={
										fullscreen
											? ({
													"--mdx-toolbar-position": "sticky",
													"--mdx-toolbar-top": "0px",
													backgroundColor: "white",
													overflow: "auto",
													padding: "2rem",
												} as React.CSSProperties)
											: ({
													"--mdx-toolbar-position": "sticky",
												} as React.CSSProperties)
									}
								>
									<ReportRenderer
										projectId={projectId ?? ""}
										reportId={data.id}
										isEditing={isEditing}
										opts={{
											contributeLink: data.show_portal_link
												? contributionLink
												: undefined,
											fullscreen,
											readingNow: views?.recent ?? 0,
											showBorder: !fullscreen,
										}}
									/>
								</div>
							</Box>

							<Divider my="lg" />

							{/* Analytics section */}
							<ProjectReportAnalytics
								projectId={projectId ?? ""}
								reportId={data.id}
							/>
						</Stack>
					) : isFallbackFromFailure ? (
						<Stack>
							<Alert
								color={latestReport.status === "cancelled" ? "yellow" : "red"}
								title={
									latestReport.status === "cancelled"
										? t`Report generation cancelled`
										: t`Something went wrong`
								}
							>
								{latestReport.status === "cancelled" ? (
									<Trans>
										Report generation was cancelled. You can start a new report
										below.
									</Trans>
								) : (
									<>
										{latestReport.error_message ? (
											<Text size="sm">{latestReport.error_message}</Text>
										) : (
											<Trans>
												Something went wrong generating your report.
											</Trans>
										)}
										<Text size="sm" c="dimmed" mt="xs">
											<Trans>You can try again below.</Trans>
										</Text>
									</>
								)}
							</Alert>
							<CreateReportForm onSuccess={() => {}} />
						</Stack>
					) : (
						<Stack>
							<Skeleton height="100px" />
							<Skeleton height="200px" />
						</Stack>
					)}
				</div>
			</ReportLayout>

			{/* Publish confirmation modal */}
			<ConfirmModal
				opened={modalOpened}
				onClose={close}
				onConfirm={handleConfirmPublish}
				title={t`Publish report`}
				message={
					participantCount !== undefined ? (
						<Trans>
							An email notification will be sent to{" "}
							<Plural
								value={participantCount}
								one="# participant"
								other="# participants"
							/>
							. Do you want to proceed?
						</Trans>
					) : (
						<Trans>
							An email notification will be sent to participants. Do you want to
							proceed?
						</Trans>
					)
				}
				confirmLabel={<Trans>Publish</Trans>}
				data-testid="report-publish-confirmation-modal"
			/>

			{/* Delete confirmation modal */}
			<ConfirmModal
				opened={deleteModalOpened}
				onClose={closeDeleteModal}
				title={t`Delete report`}
				message={t`Are you sure you want to delete this report? This action cannot be undone.`}
				confirmLabel={<Trans>Delete</Trans>}
				confirmColor="red"
				loading={isDeletingReport}
				onConfirm={handleConfirmDelete}
				data-testid="report-delete-modal"
			/>

			{/* Responsive CSS for mobile */}
			<style>{`
				@media (max-width: 768px) {
					.report-grid {
						grid-template-columns: 1fr !important;
					}
				}
			`}</style>
		</>
	);
};
