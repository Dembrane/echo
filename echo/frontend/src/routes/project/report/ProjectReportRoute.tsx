import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
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
	Modal,
	Paper,
	Skeleton,
	Stack,
	Switch,
	Text,
	Title,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { DateTimePicker } from "@mantine/dates";
import { useDisclosure, useFullscreen } from "@mantine/hooks";
import { GearSixIcon } from "@phosphor-icons/react";
import {
	IconClock,
	IconCopy,
	IconDotsVertical,
	IconLink,
	IconMaximize,
	IconMinimize,
	IconPlayerPlay,
	IconPrinter,
	IconShare2,
	IconTrash,
} from "@tabler/icons-react";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { Breadcrumbs } from "@/components/common/Breadcrumbs";
import { CloseableAlert } from "@/components/common/ClosableAlert";
import { ExponentialProgress } from "@/components/common/ExponentialProgress";
import { CreateReportForm } from "@/components/report/CreateReportForm";
import {
	useAllProjectReports,
	useCancelScheduledReportMutation,
	useCreateProjectReportMutation,
	useDeleteProjectReportMutation,
	useGetProjectParticipants,
	useLatestProjectReport,
	useProjectReport,
	useProjectReportViews,
	useReportProgress,
	useUpdateProjectReportMutation,
} from "@/components/report/hooks";
import { ReportRenderer } from "@/components/report/ReportRenderer";
import { ReportTimeline } from "@/components/report/ReportTimeline";
import { UpdateReportModalButton } from "@/components/report/UpdateReportModalButton";
import { PARTICIPANT_BASE_URL } from "@/config";
import useCopyToRichText from "@/hooks/useCopyToRichText";
import { useLanguage } from "@/hooks/useLanguage";
import { testId } from "@/lib/testUtils";

dayjs.extend(relativeTime);

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

// ── Color system ──

const STATUS_COLORS: Record<
	string,
	{ dot: string; bg: string; label: string }
> = {
	archived: { bg: "#F1F3F5", dot: "#868E96", label: "Archived" },
	draft: { bg: "#E7F5FF", dot: "#339AF0", label: "Generating" },
	published: { bg: "#E6F5F0", dot: "#0F6E56", label: "Published" },
	scheduled: { bg: "#FFF8E1", dot: "#E8A317", label: "Scheduled" },
};

function getStatusColor(status: string) {
	return STATUS_COLORS[status] ?? STATUS_COLORS.archived;
}

// ── Status dot with optional glow ──

function StatusDot({ status, size = 10 }: { status: string; size?: number }) {
	const color = getStatusColor(status);
	const hasGlow = status === "published" || status === "scheduled";
	const isGenerating = status === "draft";
	return (
		<span
			style={{
				animation: isGenerating ? "pulse 1.5s ease-in-out infinite" : undefined,
				backgroundColor: color.dot,
				borderRadius: "50%",
				boxShadow: hasGlow
					? `0 0 0 3px ${color.bg}, 0 0 6px ${color.dot}40`
					: undefined,
				display: "inline-block",
				flexShrink: 0,
				height: size,
				width: size,
			}}
		/>
	);
}

// ── Layouts ──

export const ReportLayout = ({
	children,
	rightSection,
}: {
	children: React.ReactNode;
	rightSection?: React.ReactNode;
}) => {
	return (
		<Stack
			gap="1.5rem"
			px={{ base: "1rem", md: "2rem" }}
			py={{ base: "2rem", md: "3rem" }}
		>
			<Group justify="space-between" wrap="wrap">
				<Breadcrumbs
					items={[
						{
							label: (
								<Title order={1}>
									<Trans>Report</Trans>
								</Title>
							),
						},
					]}
				/>
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
				<Title order={4}>Analytics</Title>
				<ActionIcon onClick={toggle} variant="transparent" color="gray.9">
					<GearSixIcon size={24} />
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
			<Alert title={t`Generating your report...`} mt={12}>
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
			<Group justify="flex-end" mt="md">
				<Button
					variant="outline"
					color="red"
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
	const sc = getStatusColor(report.status);
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
					? t`custom`
					: sc.label;
	const hideBadge =
		report.status === "archived" && !isLatest && !report.user_instructions;

	return (
		<UnstyledButton
			onClick={onClick}
			px="sm"
			py={8}
			style={{
				backgroundColor: isActive ? "var(--mantine-color-gray-1)" : undefined,
				borderLeft: isActive
					? "3px solid var(--mantine-color-primary-6)"
					: "3px solid transparent",
				borderRadius: 8,
			}}
			w="100%"
		>
			<Stack gap={2} style={{ minWidth: 0 }}>
				{/* Title row */}
				<Text
					size="xs"
					fw={isActive ? 600 : 500}
					lineClamp={1}
					fs={isGenerating ? "italic" : undefined}
				>
					{title}
				</Text>

				{/* Meta row: status, time, language */}
				<Group gap={6} wrap="nowrap">
					<StatusDot status={report.status} size={7} />
					{!hideBadge && (
						<Text
							size="10px"
							fw={500}
							c={
								report.status === "published"
									? "green.8"
									: report.status === "scheduled"
										? "yellow.7"
										: report.status === "draft"
											? "blue.5"
											: "gray.5"
							}
							style={{
								flexShrink: 0,
								letterSpacing: 0.5,
								textTransform: "uppercase",
							}}
						>
							{tagLabel}
						</Text>
					)}
					{!isGenerating && timeAgo && (
						<>
							<Text size="10px" c="dimmed">
								·
							</Text>
							<Text size="10px" c="dimmed" truncate style={{ flexShrink: 1 }}>
								{timeAgo}
							</Text>
						</>
					)}
					{langTag && (
						<>
							<Text size="10px" c="dimmed">
								·
							</Text>
							<Text size="10px" c="dimmed" fw={600} style={{ flexShrink: 0 }}>
								{langTag}
							</Text>
						</>
					)}
				</Group>
			</Stack>
		</UnstyledButton>
	);
}

// ── Scrollable sidebar container ──

function ScrollableSidebar({ children }: { children: React.ReactNode }) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const [canScroll, setCanScroll] = useState(false);

	const checkScroll = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		setCanScroll(el.scrollHeight > el.clientHeight + 4);
	}, []);

	useEffect(() => {
		checkScroll();
		const el = scrollRef.current;
		if (!el) return;
		const observer = new ResizeObserver(checkScroll);
		observer.observe(el);
		return () => observer.disconnect();
	}, [checkScroll]);

	return (
		<Box style={{ position: "relative" }}>
			<Box
				ref={scrollRef}
				style={{ maxHeight: 360, overflowY: "auto" }}
				onScroll={checkScroll}
			>
				{children}
			</Box>
			{canScroll && (
				<Box
					style={{
						background:
							"linear-gradient(to top, var(--mantine-color-white), transparent)",
						borderRadius: "0 0 8px 8px",
						bottom: 0,
						height: 24,
						left: 0,
						pointerEvents: "none",
						position: "absolute",
						right: 0,
					}}
				/>
			)}
		</Box>
	);
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
	const { mutate: updateReport, isPending: isRescheduling } =
		useUpdateProjectReportMutation();
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
		<Stack align="center" justify="center" py="4rem" gap="md">
			<Box
				style={{
					alignItems: "center",
					backgroundColor: "#FFF8E1",
					borderRadius: "50%",
					display: "flex",
					height: 56,
					justifyContent: "center",
					width: 56,
				}}
			>
				<IconClock size={28} color="#E8A317" />
			</Box>
			<Title order={3}>
				<Trans>Report scheduled</Trans>
			</Title>
			<Text size="sm" c="dimmed" ta="center" maw={360}>
				<Trans>
					A new report will be automatically generated and published at the
					scheduled time.
				</Trans>
			</Text>
			{scheduledTime && (
				<Badge size="lg" variant="light" color="yellow" radius="sm">
					{scheduledTime}
				</Badge>
			)}

			{showReschedule ? (
				<Stack gap="xs" w={280}>
					<DateTimePicker
						label={t`New date and time`}
						placeholder={t`Pick date and time`}
						value={newDate}
						onChange={setNewDate}
						minDate={new Date()}
						clearable
					/>
					<Button
						onClick={handleReschedule}
						loading={isRescheduling}
						disabled={!newDate || isRescheduling}
						fullWidth
						color="primary"
					>
						<Trans>Confirm reschedule</Trans>
					</Button>
					<Button
						variant="subtle"
						fullWidth
						onClick={() => setShowReschedule(false)}
					>
						<Trans>Back</Trans>
					</Button>
				</Stack>
			) : (
				<>
					<Button
						variant="outline"
						leftSection={<IconPlayerPlay size={16} />}
						onClick={handleGenerateNow}
						loading={isCancelling || isCreating}
					>
						<Trans>Generate now</Trans>
					</Button>
					<Group gap="md">
						<Tooltip
							label={t`Cannot reschedule within 10 minutes of the scheduled time`}
							disabled={canReschedule}
						>
							<Text
								size="sm"
								c={canReschedule ? "dimmed" : "gray.4"}
								td="underline"
								style={{ cursor: canReschedule ? "pointer" : "not-allowed" }}
								onClick={() => {
									if (canReschedule) setShowReschedule(true);
								}}
							>
								<Trans>Reschedule</Trans>
							</Text>
						</Tooltip>
						<Text size="sm" c="dimmed">
							·
						</Text>
						<Text
							size="sm"
							c="dimmed"
							td="underline"
							style={{ cursor: "pointer" }}
							onClick={handleCancelSchedule}
						>
							<Trans>Cancel schedule</Trans>
						</Text>
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

	// Determine which report to display (never load content for a scheduled or draft report)
	const activeReportId = (() => {
		if (selectedReportId && !isViewingScheduled && !isViewingGenerating)
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

	const contributionLink = `${PARTICIPANT_BASE_URL}/${language}/${projectId}/start`;

	const getSharingLink = (pid: string) =>
		`${PARTICIPANT_BASE_URL}/${language}/${pid}/report`;

	const { copy: copyLink, copied: copiedLink } = useCopyToRichText();
	const { copy: copyContent, copied: copiedContent } = useCopyToRichText();

	const handleSelectReport = (id: number) => {
		setSelectedReportId(id === latestCompletedId ? null : id);
	};

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
				rightSection={
					<Group gap="xs">
						{/* Update/New report */}
						{data && <UpdateReportModalButton reportId={data.id} />}
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
						<Paper withBorder p="sm" radius="md">
							<Stack gap="xs">
								<Group justify="space-between" px={4}>
									<Text
										size="xs"
										fw={600}
										tt="uppercase"
										c="dimmed"
										style={{ letterSpacing: 0.5 }}
									>
										<Trans>Reports</Trans>
									</Text>
									{sidebarReports.length > 0 && (
										<Badge size="xs" variant="light" color="gray" circle>
											{sidebarReports.length}
										</Badge>
									)}
								</Group>
								<ScrollableSidebar>
									<Stack gap={2}>
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
									<Text size="xs" c="dimmed" ta="center" py="xs">
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
								radius="md"
								p="sm"
								style={{
									backgroundColor: "var(--mantine-color-body)",
									position: "sticky",
									top: "1rem",
									zIndex: 10,
								}}
							>
								<Stack gap={0}>
									{/* Row 1: Distribution — report state */}
									<Group justify="space-between" wrap="wrap" gap="sm" py={4}>
										<Group gap="md" wrap="wrap">
											<Switch
												label={
													<Text size="sm" fw={600}>
														{data.status === "published"
															? t`Published`
															: t`Publish`}
													</Text>
												}
												checked={data.status === "published"}
												color="primary"
												size="sm"
												onChange={(e) => {
													const isPublishing = e.target.checked;
													const participantsToNotify = participantCount ?? 0;

													if (isPublishing) {
														if (participantsToNotify > 0) {
															setPublishStatus(true);
															open();
														} else {
															updateReport({
																payload: { status: "published" },
																projectId: projectId ?? "",
																reportId: data.id,
															});
														}
													} else {
														updateReport({
															payload: { status: "archived" },
															projectId: projectId ?? "",
															reportId: data.id,
														});
													}
												}}
												disabled={isUpdatingReport}
												{...testId("report-publish-toggle")}
											/>
											<Tooltip
												label={t`Publish this report first to show the portal link`}
												disabled={data.status === "published"}
												events={{ focus: true, hover: true, touch: true }}
											>
												<Box
													style={{
														opacity: data.status !== "published" ? 0.45 : 1,
													}}
												>
													<Switch
														label={t`Include portal link`}
														checked={data.show_portal_link ?? true}
														size="sm"
														onChange={(e) => {
															updateReport({
																payload: {
																	show_portal_link: !!e.target.checked,
																},
																projectId: projectId ?? "",
																reportId: data.id,
															});
														}}
														disabled={
															isUpdatingReport || data.status !== "published"
														}
														{...testId("report-include-portal-link-checkbox")}
													/>
												</Box>
											</Tooltip>
										</Group>

										{/* Copy link + kebab — actions */}
										<Group gap="xs" wrap="nowrap">
											<Tooltip
												label={
													data.status !== "published"
														? t`Publish this report to get a share link`
														: copiedLink
															? t`Copied!`
															: t`Copy link to clipboard`
												}
												events={{ focus: true, hover: true, touch: true }}
											>
												<Box>
													<Button
														variant={copiedLink ? "filled" : "default"}
														color={copiedLink ? "primary" : undefined}
														size="compact-sm"
														leftSection={<IconLink size={14} />}
														onClick={() => {
															if (data.status === "published") {
																copyLink(getSharingLink(projectId ?? ""));
															}
														}}
														disabled={data.status !== "published"}
														{...testId("report-copy-link-button")}
													>
														{copiedLink ? (
															<Trans>Copied!</Trans>
														) : (
															<Trans>Copy link</Trans>
														)}
													</Button>
												</Box>
											</Tooltip>

											<Menu shadow="md" position="bottom-end">
												<Menu.Target>
													<Tooltip label={t`More actions`}>
														<ActionIcon
															variant="subtle"
															color="gray"
															{...testId("report-actions-menu")}
														>
															<IconDotsVertical size={18} />
														</ActionIcon>
													</Tooltip>
												</Menu.Target>
												<Menu.Dropdown>
													<Menu.Item
														leftSection={<IconCopy size={16} />}
														onClick={() => {
															if (activeReport?.content) {
																copyContent(activeReport.content);
															}
														}}
														{...testId("report-copy-content-button")}
													>
														{copiedContent ? (
															<Trans>Copied!</Trans>
														) : (
															<Trans>Copy report content</Trans>
														)}
													</Menu.Item>
													<Menu.Item
														leftSection={<IconShare2 size={16} />}
														onClick={() => {
															const url = getSharingLink(projectId ?? "");
															if (data.status === "published") {
																if (url && navigator.canShare?.({ url })) {
																	navigator.share({ url });
																} else {
																	window.open(url, "_blank");
																}
															}
														}}
														disabled={data.status !== "published"}
														{...testId("report-share-button")}
													>
														<Trans>Share report</Trans>
													</Menu.Item>
													<Menu.Item
														leftSection={<IconPrinter size={16} />}
														onClick={() => {
															if (data.status === "published") {
																window.open(
																	`${getSharingLink(projectId ?? "")}?print=true`,
																	"_blank",
																);
															}
														}}
														disabled={data.status !== "published"}
														{...testId("report-print-button")}
													>
														<Trans>Print report</Trans>
													</Menu.Item>
													<Menu.Divider />
													<Menu.Item
														leftSection={<IconTrash size={16} />}
														color="red"
														onClick={openDeleteModal}
														{...testId("report-delete-button")}
													>
														<Trans>Delete report</Trans>
													</Menu.Item>
												</Menu.Dropdown>
											</Menu>
										</Group>
									</Group>

									{/* Separator between distribution and view controls */}
									<Divider my={4} />

									{/* Row 2: View controls + metadata */}
									<Group justify="space-between" wrap="wrap" gap="sm" py={4}>
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
												{(views?.total ?? 0) === 1 ? (
													<Trans>1 view</Trans>
												) : (
													<Trans>{views?.total ?? 0} views</Trans>
												)}
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
														label={activeReportMeta.user_instructions}
														multiline
														maw={300}
														position="bottom"
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
															<Trans>Instructions</Trans>
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
													variant="subtle"
													color="gray"
													{...testId("report-fullscreen-button")}
												>
													{fullscreen ? (
														<IconMinimize size={18} />
													) : (
														<IconMaximize size={18} />
													)}
												</ActionIcon>
											</Tooltip>
										</Group>
									</Group>
								</Stack>
							</Paper>

							{/* ── Largest gap: separates toolbar from preview ── */}
							<Box mt={24}>
								<div
									ref={fullscreenRef}
									style={
										fullscreen
											? ({
													"--mdx-toolbar-top": "0px",
													backgroundColor: "white",
													overflow: "auto",
													padding: "2rem",
												} as React.CSSProperties)
											: undefined
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
			<Modal
				opened={modalOpened}
				onClose={close}
				title={t`Confirm Publishing`}
				{...testId("report-publish-confirmation-modal")}
			>
				<Text size="sm">
					<Trans>
						An email notification will be sent to{" "}
						{participantCount !== undefined ? participantCount : t`loading...`}{" "}
						participant{participantCount === 1 ? "" : "s"}. Do you want to
						proceed?
					</Trans>
				</Text>
				<Group mt="md" justify="end">
					<Button
						onClick={close}
						variant="outline"
						{...testId("report-publish-cancel-button")}
					>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						onClick={handleConfirmPublish}
						color="primary"
						{...testId("report-publish-proceed-button")}
					>
						<Trans>Proceed</Trans>
					</Button>
				</Group>
			</Modal>

			{/* Delete confirmation modal */}
			<Modal
				opened={deleteModalOpened}
				onClose={closeDeleteModal}
				title={t`Delete Report`}
				{...testId("report-delete-confirmation-modal")}
			>
				<Text size="sm">
					<Trans>
						Are you sure you want to delete this report? This action cannot be
						undone.
					</Trans>
				</Text>
				<Group mt="md" justify="end">
					<Button
						onClick={closeDeleteModal}
						variant="outline"
						{...testId("report-delete-cancel-button")}
					>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						onClick={handleConfirmDelete}
						color="red"
						loading={isDeletingReport}
						{...testId("report-delete-confirm-button")}
					>
						<Trans>Delete</Trans>
					</Button>
				</Group>
			</Modal>

			{/* Responsive CSS for mobile + pulse animation */}
			<style>{`
				@media (max-width: 768px) {
					.report-grid {
						grid-template-columns: 1fr !important;
					}
				}
				@keyframes pulse {
					0%, 100% { opacity: 1; }
					50% { opacity: 0.4; }
				}
			`}</style>
		</>
	);
};
