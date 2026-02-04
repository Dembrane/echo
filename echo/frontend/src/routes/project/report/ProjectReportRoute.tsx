import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Badge,
	Button,
	Checkbox,
	Divider,
	Group,
	Modal,
	Skeleton,
	Stack,
	Switch,
	Text,
	Title,
	Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { GearSixIcon } from "@phosphor-icons/react";
import { IconPrinter, IconShare2 } from "@tabler/icons-react";
import { AnimatePresence } from "motion/react";
import { useState } from "react";
import { useParams } from "react-router";
import { Breadcrumbs } from "@/components/common/Breadcrumbs";
import { CopyIconButton } from "@/components/common/CopyIconButton";
import { CreateReportForm } from "@/components/report/CreateReportForm";
import {
	useGetProjectParticipants,
	useLatestProjectReport,
	useProjectReportViews,
	useUpdateProjectReportMutation,
} from "@/components/report/hooks";
import { ReportRenderer } from "@/components/report/ReportRenderer";
import { ReportTimeline } from "@/components/report/ReportTimeline";
import { UpdateReportModalButton } from "@/components/report/UpdateReportModalButton";
import { PARTICIPANT_BASE_URL } from "@/config";
import useCopyToRichText from "@/hooks/useCopyToRichText";
import { testId } from "@/lib/testUtils";

export const ReportLayout = ({
	children,
	rightSection,
}: {
	children: React.ReactNode;
	rightSection?: React.ReactNode;
}) => {
	return (
		<Stack
			gap="3rem"
			px={{ base: "1rem", md: "2rem" }}
			py={{ base: "2rem", md: "4rem" }}
		>
			<Group justify="space-between">
				<Breadcrumbs
					items={[
						{
							label: (
								<Group>
									<Title order={1}>
										<Trans>Report</Trans>
									</Title>
									<Badge>
										<Trans>Beta</Trans>
									</Badge>
								</Group>
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

const ProjectReportAnalytics = ({ reportId }: { reportId: number }) => {
	const { data: views } = useProjectReportViews(reportId);

	const [opened, { toggle }] = useDisclosure();

	return (
		<Stack gap="1.5rem">
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

export const ProjectReportRoute = () => {
	const { projectId, language } = useParams();
	const { data, isLoading } = useLatestProjectReport(projectId ?? "");
	const { data: views } = useProjectReportViews(data?.id ?? -1);
	const { mutate: updateProjectReport, isPending: isUpdatingReport } =
		useUpdateProjectReportMutation();
	const [modalOpened, { open, close }] = useDisclosure(false);
	const [publishStatus, setPublishStatus] = useState(false);
	const [isEditing, setIsEditing] = useState(false);
	const { data: participantCount } = useGetProjectParticipants(projectId ?? "");
	const handleConfirmPublish = () => {
		if (!data?.id) return;
		updateProjectReport({
			payload: {
				project_id: { id: data.project_id } as Project,
				status: publishStatus ? "published" : "archived",
			},
			reportId: data.id,
		});
		close();
	};

	const contributionLink = `${PARTICIPANT_BASE_URL}/${language}/${projectId}/start`;

	const getSharingLink = (projectId: string) =>
		`${PARTICIPANT_BASE_URL}/${language}/${projectId}/report`;

	const { copy, copied } = useCopyToRichText();

	if (isLoading) {
		return (
			<ReportLayout>
				<Divider />
				<Skeleton height="100px" />
				<Skeleton height="200px" />
			</ReportLayout>
		);
	}

	if (!data) {
		return (
			<ReportLayout>
				<Divider />
				<CreateReportForm onSuccess={() => {}} />
			</ReportLayout>
		);
	}

	if (data.status === "error") {
		return (
			<ReportLayout>
				<Title order={2}>
					<Trans>
						Report generation is currently in beta and limited to projects with
						fewer than 10 hours of recording.
					</Trans>
				</Title>

				<Text>
					<Trans>
						There was an error generating your report. In the meantime, you can
						analyze all your data using the library or select specific
						conversations to chat with.
					</Trans>
				</Text>
			</ReportLayout>
		);
	}

	return (
		<ReportLayout
			rightSection={
				<Group>
					<UpdateReportModalButton reportId={data.id} />
					<AnimatePresence>
						{data.status === "published" && (
							<Group>
								<Tooltip label={t`Share this report`}>
									<ActionIcon
										onClick={() => {
											const url = getSharingLink(data.project_id ?? "");
											if (url && navigator.canShare({ url })) {
												navigator.share({ url });
											} else {
												window.open(url, "_blank");
											}
										}}
										variant="transparent"
										color="gray.9"
										size={24}
										className="lg:hidden"
										{...testId("report-share-button")}
									>
										<IconShare2 />
									</ActionIcon>
								</Tooltip>

								<CopyIconButton
									onCopy={() => {
										copy(getSharingLink(data.project_id ?? ""));
									}}
									copyTooltip={t`Copy link to share this report`}
									copied={copied}
									variant="transparent"
									color="gray.9"
									size={20}
									{...testId("report-copy-link-button")}
								/>

								<Tooltip label={t`Print this report`}>
									<ActionIcon
										onClick={() => {
											window.open(
												`${getSharingLink(data.project_id ?? "")}?print=true`,
												"_blank",
											);
										}}
										variant="transparent"
										color="gray.9"
										size={24}
										{...testId("report-print-button")}
									>
										<IconPrinter />
									</ActionIcon>
								</Tooltip>

								<Divider orientation="vertical" />
							</Group>
						)}
					</AnimatePresence>
					<Switch
						label={data.status === "published" ? t`Published` : t`Publish`}
						checked={data.status === "published"}
						size={data.status === "published" ? "md" : "sm"}
						onChange={(e) => {
							const isPublishing = e.target.checked;
							const participantsToNotify = participantCount ?? 0;

							if (isPublishing) {
								if (participantsToNotify > 0) {
									setPublishStatus(true);
									open();
								} else {
									updateProjectReport({
										payload: {
											project_id: { id: data.project_id } as Project,
											status: "published",
										},
										reportId: data.id,
									});
								}
							} else {
								updateProjectReport({
									payload: {
										project_id: { id: data.project_id } as Project,
										status: "archived",
									},
									reportId: data.id,
								});
							}
						}}
						disabled={isUpdatingReport}
						{...testId("report-publish-toggle")}
					/>
				</Group>
			}
		>
			<Divider />
			<Stack gap="3rem">
				<ProjectReportAnalytics reportId={data.id} />

				<Stack gap="1.5rem">
					<Title order={4}>Settings</Title>
					<Stack gap="1rem">
						<Checkbox
							label={t`Include portal link in report`}
							checked={data.show_portal_link ?? true}
							onChange={(e) => {
								updateProjectReport({
									payload: {
										project_id: { id: data.project_id } as Project,
										show_portal_link: !!e.target.checked,
									},
									reportId: data.id,
								});
							}}
							disabled={isUpdatingReport}
							{...testId("report-include-portal-link-checkbox")}
						/>
						<Checkbox
							label={t`Show timeline in report (request feature)`}
							checked={false}
							disabled
						/>
						<Checkbox
							label={t`Password protect portal (request feature)`}
							checked={false}
							disabled
						/>
					</Stack>
				</Stack>

				<Divider />
				<div className="flex justify-end">
					<Switch
						label={t`Editing mode`}
						checked={isEditing}
						onChange={() => setIsEditing(!isEditing)}
						size="md"
						{...testId("report-editing-mode-toggle")}
					/>
				</div>
				<ReportRenderer
					reportId={data.id}
					isEditing={isEditing}
					opts={{
						contributeLink: data.show_portal_link
							? contributionLink
							: undefined,
						readingNow: views?.recent ?? 0,
						showBorder: true,
					}}
				/>
				<Modal
					opened={modalOpened}
					onClose={close}
					title={t`Confirm Publishing`}
					{...testId("report-publish-confirmation-modal")}
				>
					<Text size="sm">
						<Trans>
							An email notification will be sent to{" "}
							{participantCount !== undefined
								? participantCount
								: t`loading...`}{" "}
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
			</Stack>
		</ReportLayout>
	);
};
