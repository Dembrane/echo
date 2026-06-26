import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Modal, Stack, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { NotePencilIcon } from "@phosphor-icons/react";
import { useCallback } from "react";
import { useLocation, useParams } from "react-router";
import { UpgradeModal } from "@/components/workspace/FeatureGate";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useWorkspaceUsage } from "@/hooks/useWorkspaceUsage";
import { testId } from "@/lib/testUtils";
import { SELLABLE_TIER, type Tier } from "@/lib/tiers";
import { NavigationButton } from "../common/NavigationButton";
import { CreateReportForm } from "./CreateReportForm";
import { useLatestProjectReport } from "./hooks";

export const ReportModalNavigationButton = () => {
	const [opened, { open, close }] = useDisclosure();
	const [upgradeOpened, upgradeHandlers] = useDisclosure(false);

	const navigate = useI18nNavigate();

	const { projectId, workspaceId } = useParams();
	const { pathname } = useLocation();
	const { workspace } = useWorkspace();
	const { freeTier } = useWorkspaceUsage(workspace?.id);
	const atReportLimit = Boolean(
		freeTier?.active && freeTier.reports_used >= freeTier.reports_limit,
	);

	const { data: projectReport, isFetching: isLoadingProjectReport } =
		useLatestProjectReport(projectId ?? "");

	const handleClick = useCallback(() => {
		if (projectReport) {
			navigate(`/w/${workspaceId}/projects/${projectId}/report`);
		} else if (atReportLimit) {
			upgradeHandlers.open();
		} else {
			open();
		}
	}, [projectReport, navigate, open, projectId, workspaceId, atReportLimit, upgradeHandlers]);

	const handleSuccess = useCallback(() => {
		close();
		navigate(`/w/${workspaceId}/projects/${projectId}/report`);
	}, [navigate, projectId, workspaceId, close]);

	return (
		<>
			<Modal
				opened={opened}
				onClose={close}
				title={
					<Text fw={500} size="lg">
						<Trans>Create Report</Trans>
					</Text>
				}
				withinPortal
				classNames={{
					header: "border-b",
				}}
				{...testId("report-create-modal")}
			>
				<Stack>
					<CreateReportForm onSuccess={handleSuccess} />
				</Stack>
			</Modal>

			<UpgradeModal
				opened={upgradeOpened}
				onClose={upgradeHandlers.close}
				currentTier={(workspace?.tier ?? "free") as Tier}
				requiredTier={SELLABLE_TIER}
				featureName={t`Report limit reached`}
				benefit={t`Your free plan includes one report. Upgrade to create more.`}
				canRequestUpgrade={
					workspace?.role === "admin" || workspace?.role === "owner"
				}
				workspaceId={workspace?.id ?? ""}
			/>

			<NavigationButton
				loading={isLoadingProjectReport}
				loadingTooltip={t`Connecting to report services...`}
				onClick={handleClick}
				rightIcon={<NotePencilIcon size={24} color="var(--app-text)" />}
				active={pathname.includes("report")}
				{...testId("sidebar-report-button")}
			>
				<Trans>Report</Trans>
			</NavigationButton>
		</>
	);
};
